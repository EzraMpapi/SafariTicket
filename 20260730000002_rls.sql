-- Row Level Security.
--
-- This file is the reason the anon key is safe to ship in a browser bundle.
-- Supabase's anon key is public by design — it is inlined into the client and
-- visible to anyone who opens devtools. It is only a credential in the sense
-- that it identifies the project; the *authorisation* is entirely here.
--
-- Without these policies, VITE_SUPABASE_ANON_KEY is full read/write access to
-- every table in this database.
--
-- Posture: deny everything, then open the narrowest possible holes.
--   * Reference data is world-readable and never writable.
--   * Seat inventory is never touched directly — only through the RPCs below,
--     which are SECURITY DEFINER and validate their own inputs. If anon could
--     insert into seat_occupancy directly, one script could hold every seat on
--     every coach.
--   * Bookings, tickets, passengers, payments, keys and audit rows are
--     unreachable from the client at any privilege. Retrieval goes through an
--     RPC that requires a locator *and* a surname.

-- ── enable RLS everywhere, including tables added later by mistake ──────────

alter table cabin_class        enable row level security;
alter table carrier            enable row level security;
alter table station            enable row level security;
alter table signing_key        enable row level security;
alter table seat_occupancy     enable row level security;
alter table booking            enable row level security;
alter table booking_passenger  enable row level security;
alter table ticket             enable row level security;
alter table payment            enable row level security;
alter table payment_event      enable row level security;
alter table gate_device        enable row level security;
alter table boarding_scan      enable row level security;
alter table disruption         enable row level security;
alter table compensation       enable row level security;
alter table audit_log          enable row level security;

-- Force RLS even for the table owner, so a future migration running as owner
-- cannot quietly bypass these policies.
alter table booking            force row level security;
alter table booking_passenger  force row level security;
alter table ticket             force row level security;
alter table signing_key        force row level security;
alter table payment            force row level security;

-- ── strip the default grants Supabase hands to anon ────────────────────────

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;

-- ── reference data: readable by anyone, writable by no one ──────────────────

grant select on cabin_class, carrier, station to anon, authenticated;

create policy "reference data is public" on cabin_class for select to anon, authenticated using (true);
create policy "reference data is public" on carrier     for select to anon, authenticated using (true);
create policy "reference data is public" on station     for select to anon, authenticated using (true)
  ;

-- Open disruptions are public: a traveller must be able to see that their
-- coach is delayed without authenticating.
grant select on disruption to anon, authenticated;
create policy "open disruptions are public" on disruption
  for select to anon, authenticated
  using (cleared_at is null);

-- ── everything else: no policy, therefore no access ─────────────────────────
--
-- A table with RLS enabled and no permissive policy denies every row to every
-- non-superuser role. That is the intended state for seat_occupancy, booking,
-- booking_passenger, ticket, payment, payment_event, gate_device,
-- boarding_scan, compensation, signing_key and audit_log.
--
-- service_role bypasses RLS by design and is used only by Edge Functions, which
-- run server-side and never expose their key to a browser.

-- ── narrow RPC surface ─────────────────────────────────────────────────────
--
-- Every function below is SECURITY DEFINER with a pinned search_path. Pinning
-- matters: without it, a caller who can create objects in an earlier schema can
-- shadow a function name and have it executed with the definer's privileges.

create or replace function public.seat_availability(p_service_key text, p_capacity smallint default 44)
returns smallint[]
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  taken smallint[];
  free  smallint[] := '{}';
  s     smallint;
begin
  if p_service_key is null or length(p_service_key) > 120 then
    raise exception 'invalid service key' using errcode = '22023';
  end if;
  if p_capacity < 1 or p_capacity > 200 then
    raise exception 'invalid capacity' using errcode = '22023';
  end if;

  select coalesce(array_agg(seat_no), '{}') into taken
  from seat_occupancy
  where service_key = p_service_key
    and (state = 'CONFIRMED' or (state = 'HELD' and expires_at > now()));

  for s in 1..p_capacity loop
    if not (s = any (taken)) then free := free || s; end if;
  end loop;

  return free;
end;
$$;

/*
  Atomic seat hold.

  The INSERT is the lock. There is deliberately no "check then write": the
  partial unique index rejects a taken seat, and a unique violation is
  translated into a clean application error. Because the whole function body is
  one transaction, a partially granted basket rolls back on its own.
*/
create or replace function public.hold_seats(
  p_service_key text,
  p_seats        smallint[],
  p_ttl_seconds  integer default 600
)
returns table (hold_token uuid, seats smallint[], expires_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_token   uuid := gen_random_uuid();
  v_expires timestamptz := now() + make_interval(secs => p_ttl_seconds);
  v_seat    smallint;
begin
  if p_service_key is null or length(p_service_key) > 120 then
    raise exception 'invalid service key' using errcode = '22023';
  end if;
  if p_seats is null or array_length(p_seats, 1) is null then
    raise exception 'at least one seat is required' using errcode = '22023';
  end if;
  -- Bound the basket so one caller cannot hold a whole coach.
  if array_length(p_seats, 1) > 6 then
    raise exception 'at most six seats may be held at once' using errcode = '22023';
  end if;
  if p_ttl_seconds < 60 or p_ttl_seconds > 3600 then
    raise exception 'ttl out of range' using errcode = '22023';
  end if;
  if array_length(p_seats, 1) <> (select count(distinct x) from unnest(p_seats) x) then
    raise exception 'duplicate seat in request' using errcode = '22023';
  end if;

  -- Clear this seat's own lapsed hold, if any. Cheap, indexed, and usually a
  -- no-op; it keeps an expired hold from blocking a live one.
  update seat_occupancy
     set state = 'RELEASED', expires_at = null
   where service_key = p_service_key
     and seat_no = any (p_seats)
     and state = 'HELD'
     and expires_at <= now();

  foreach v_seat in array p_seats loop
    begin
      insert into seat_occupancy (service_key, seat_no, state, hold_token, expires_at)
      values (p_service_key, v_seat, 'HELD', v_token, v_expires);
    exception when unique_violation then
      raise exception 'seat % is no longer available', v_seat
        using errcode = 'P0001', hint = v_seat::text, detail = 'SEAT_TAKEN';
    end;
  end loop;

  return query select v_token, p_seats, v_expires;
end;
$$;

create or replace function public.release_hold(p_hold_token uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare n integer;
begin
  update seat_occupancy
     set state = 'RELEASED', expires_at = null
   where hold_token = p_hold_token and state = 'HELD';
  get diagnostics n = row_count;
  return n;
end;
$$;

create or replace function public.extend_hold(p_hold_token uuid, p_ttl_seconds integer default 600)
returns timestamptz
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_expires timestamptz := now() + make_interval(secs => p_ttl_seconds);
begin
  if p_ttl_seconds < 60 or p_ttl_seconds > 3600 then
    raise exception 'ttl out of range' using errcode = '22023';
  end if;

  -- An expired hold is not resurrected: those seats may already belong to
  -- someone else.
  update seat_occupancy
     set expires_at = v_expires
   where hold_token = p_hold_token and state = 'HELD' and expires_at > now();

  if not found then
    raise exception 'hold has expired' using errcode = 'P0001', detail = 'HOLD_EXPIRED';
  end if;
  return v_expires;
end;
$$;

/*
  Booking retrieval. Two identifiers, as at any ticket counter.

  Returns no document numbers, ever. A wrong surname produces the same empty
  result as a non-existent locator, so the function cannot be used to discover
  which references exist.
*/
create or replace function public.get_booking(p_locator text, p_surname text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare result jsonb;
begin
  if p_locator is null or p_surname is null then
    raise exception 'locator and surname are required' using errcode = '22023';
  end if;

  select jsonb_build_object(
           'locator', b.locator,
           'status', b.status,
           'issuedAt', b.issued_at,
           'segments', b.segments,
           'total', b.total_minor,
           'currency', b.currency,
           'quote', b.quote_snapshot,
           'flexible', b.flexible,
           'contact', jsonb_build_object('phoneE164', b.contact_phone, 'email', b.contact_email),
           'passengers', (
             select coalesce(jsonb_agg(jsonb_build_object(
                      'firstName', p.given_name,
                      'lastName',  p.family_name,
                      'type',      p.pax_type,
                      'documentType', p.document_type
                    ) order by p.pax_index), '[]'::jsonb)
             from booking_passenger p where p.booking_id = b.id
           ),
           'tickets', (
             select coalesce(jsonb_agg(jsonb_build_object(
                      'ticketNumber', t.ticket_number,
                      'seatNo', t.seat_no,
                      'legIndex', t.leg_index,
                      'barcode', t.barcode
                    ) order by t.leg_index, t.seat_no), '[]'::jsonb)
             from ticket t where t.booking_id = b.id
           )
         )
    into result
    from booking b
   where b.locator = upper(p_locator)
     and exists (
       select 1 from booking_passenger p
        where p.booking_id = b.id
          and lower(p.family_name) = lower(trim(p_surname))
     );

  return result;   -- null when either identifier fails to match
end;
$$;

-- ── grants: only these functions, only to anon ──────────────────────────────

grant execute on function public.seat_availability(text, smallint) to anon, authenticated;
grant execute on function public.hold_seats(text, smallint[], integer) to anon, authenticated;
grant execute on function public.release_hold(uuid) to anon, authenticated;
grant execute on function public.extend_hold(uuid, integer) to anon, authenticated;
grant execute on function public.get_booking(text, text) to anon, authenticated;

-- Housekeeping only. Correctness never depends on it: an expired hold stops
-- conflicting the moment it expires. Schedule with pg_cron if desired.
create or replace function public.sweep_expired_holds()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare n integer;
begin
  update seat_occupancy
     set state = 'RELEASED', expires_at = null
   where state = 'HELD' and expires_at <= now();
  get diagnostics n = row_count;
  return n;
end;
$$;

-- Deliberately not granted to anon.
revoke all on function public.sweep_expired_holds() from anon, authenticated;
