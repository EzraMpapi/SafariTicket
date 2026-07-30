-- Booking issuance, as one transaction.
--
-- Confirming the seat hold and inserting the booking must be atomic. If they
-- are separate round trips and the process dies between them, a seat is sold
-- with no booking attached — unrecoverable without manual intervention.
--
-- Called only by the issue-ticket Edge Function using the service_role key.
-- Never granted to anon: it takes a signed barcode as input, and a client that
-- could call it directly could mint tickets.

create or replace function public.confirm_booking(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_booking_id  uuid;
  v_locator     char(6) := upper(p->>'locator');
  v_hold_token  uuid    := (p->>'holdToken')::uuid;
  v_held_seats  smallint[];
  v_pax         jsonb;
  v_pax_id      uuid;
  v_idx         integer := 0;
  v_ticket      jsonb;
begin
  -- The hold must still be live. Checking inside the transaction closes the
  -- window between validation and insert.
  select coalesce(array_agg(seat_no order by seat_no), '{}')
    into v_held_seats
    from seat_occupancy
   where hold_token = v_hold_token
     and state = 'HELD'
     and expires_at > now();

  if array_length(v_held_seats, 1) is null then
    raise exception 'hold has expired' using errcode = 'P0001', detail = 'HOLD_EXPIRED';
  end if;

  insert into booking (
    locator, contact_phone, contact_email, currency,
    total_minor, fare_minor, tax_minor, fee_minor,
    quote_snapshot, segments, flexible
  ) values (
    v_locator,
    p->'contact'->>'phoneE164',
    nullif(p->'contact'->>'email', ''),
    coalesce(p->>'currency', 'TZS'),
    (p->>'totalMinor')::bigint,
    (p->>'fareMinor')::bigint,
    (p->>'taxMinor')::bigint,
    (p->>'feeMinor')::bigint,
    p->'quote',
    p->'segments',
    coalesce((p->>'flexible')::boolean, false)
  )
  returning id into v_booking_id;

  for v_pax in select * from jsonb_array_elements(p->'passengers') loop
    insert into booking_passenger (
      booking_id, pax_index, given_name, family_name, pax_type,
      nationality, document_type, document_cipher, document_index
    ) values (
      v_booking_id, v_idx,
      v_pax->>'firstName', v_pax->>'lastName', v_pax->>'type',
      v_pax->>'nationality', v_pax->>'documentType',
      decode(v_pax->>'documentCipher', 'base64'),
      v_pax->>'documentIndex'
    )
    returning id into v_pax_id;

    for v_ticket in
      select * from jsonb_array_elements(p->'tickets')
       where (value->>'paxIndex')::int = v_idx
    loop
      insert into ticket (
        booking_id, passenger_id, leg_index, ticket_number, seat_no, barcode, signing_key_id
      ) values (
        v_booking_id, v_pax_id,
        (v_ticket->>'legIndex')::smallint,
        v_ticket->>'ticketNumber',
        (v_ticket->>'seatNo')::smallint,
        v_ticket->>'barcode',
        v_ticket->>'signingKeyId'
      );
    end loop;

    v_idx := v_idx + 1;
  end loop;

  -- Same transaction as the inserts above.
  update seat_occupancy
     set state = 'CONFIRMED', booking_id = v_booking_id, expires_at = null
   where hold_token = v_hold_token and state = 'HELD';

  insert into audit_log (actor, action, subject, detail)
  values ('edge:issue-ticket', 'BOOKING_ISSUED', v_locator,
          jsonb_build_object('seats', v_held_seats, 'total', (p->>'totalMinor')::bigint));

  return jsonb_build_object('bookingId', v_booking_id, 'locator', v_locator, 'seats', v_held_seats);
end;
$$;

revoke all on function public.confirm_booking(jsonb) from anon, authenticated;

create or replace function public.record_scans(p jsonb)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare n integer := 0;
begin
  -- ON CONFLICT DO NOTHING is what makes a resending offline device harmless.
  with inserted as (
    insert into boarding_scan (device_id, service_key, locator, seat_no, result_code, accepted, scanned_at)
    select nullif(s->>'deviceId','')::uuid, s->>'serviceKey', s->>'locator',
           (s->>'seatNo')::smallint, s->>'resultCode', (s->>'accepted')::boolean,
           (s->>'scannedAt')::timestamptz
      from jsonb_array_elements(p->'scans') s
    on conflict do nothing
    returning 1
  )
  select count(*) into n from inserted;
  return n;
end;
$$;

revoke all on function public.record_scans(jsonb) from anon, authenticated;

-- Seed the signing key registry. Secrets live in Edge Function environment
-- variables; this table holds only the identifier and lifecycle state.
insert into signing_key (id, kms_key_ref, state)
values ('K2', 'env:TICKET_SIGNING_KEYS#K2', 'ACTIVE')
on conflict (id) do nothing;

/*
  Cancellation.

  Releases the seats and marks the booking refunded in one transaction. The
  refund amount is computed by the client from the published table and passed
  in, then recorded — it is not trusted as an instruction to move money. Actual
  disbursement happens in the payments pipeline against this record.

  Requires locator and surname, the same two identifiers as retrieval, so a
  locator alone cannot cancel someone's journey.
*/
create or replace function public.cancel_booking(
  p_locator text,
  p_surname text,
  p_refund_minor bigint,
  p_refund_pct smallint
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  select b.id into v_id
    from booking b
   where b.locator = upper(p_locator)
     and b.status = 'CONFIRMED'
     and exists (
       select 1 from booking_passenger p
        where p.booking_id = b.id
          and lower(p.family_name) = lower(trim(p_surname))
     );

  if v_id is null then
    -- Same answer for "no such booking", "wrong surname" and "already
    -- cancelled": none of them should be distinguishable from outside.
    return null;
  end if;

  if p_refund_minor < 0 or p_refund_pct < 0 or p_refund_pct > 100 then
    raise exception 'invalid refund' using errcode = '22023';
  end if;

  update booking set status = 'REFUNDED' where id = v_id;

  update seat_occupancy
     set state = 'RELEASED', expires_at = null
   where booking_id = v_id and state = 'CONFIRMED';

  insert into audit_log (actor, action, subject, detail)
  values ('rpc:cancel_booking', 'BOOKING_CANCELLED', upper(p_locator),
          jsonb_build_object('refundMinor', p_refund_minor, 'refundPct', p_refund_pct));

  return jsonb_build_object('locator', upper(p_locator), 'status', 'REFUNDED',
                            'refundMinor', p_refund_minor, 'refundPct', p_refund_pct);
end;
$$;

grant execute on function public.cancel_booking(text, text, bigint, smallint) to anon, authenticated;
