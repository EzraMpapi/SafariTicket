-- SafariTiketi core schema for Supabase.
--
-- Two corrections against the earlier standalone schema, both of which would
-- have failed on first apply:
--   * carrier referenced cabin_class before it existed
--   * ticket referenced signing_key before it existed
-- DEFERRABLE defers constraint *checking*, not table resolution, so ordering
-- still matters. Reference tables are now created first.
--
-- One deliberate simplification: seat_occupancy keys on service_key (text)
-- rather than a foreign key to a service table. Inventory is still generated
-- deterministically by @safaritiketi/domain, so there is no catalogue to
-- reference yet. The trade-off is no referential integrity against a service
-- list; it is recorded in README under "known trade-offs" rather than hidden.

-- ── reference data (created before anything that references it) ─────────────

create table if not exists cabin_class (
  code          text primary key,
  label         text not null,
  fare_basis    text not null,
  rate_per_km   integer not null check (rate_per_km > 0),
  baggage_kg    smallint not null,
  seat_pitch_cm smallint not null
);

create table if not exists carrier (
  code          char(2) primary key,
  numeric_code  char(3) not null unique,
  name          text not null,
  cabin_default text not null references cabin_class(code),
  on_time_pct   smallint not null default 0 check (on_time_pct between 0 and 100)
);

create table if not exists station (
  code     char(3) primary key,
  name     text not null,
  terminal text not null,
  lat      numeric(8,5) not null,
  lon      numeric(8,5) not null,
  active   boolean not null default true
);

create table if not exists signing_key (
  id           char(2) primary key,
  kms_key_ref  text not null,
  algorithm    text not null default 'HMAC-SHA256-T64',
  state        text not null check (state in ('ACTIVE','VERIFY_ONLY','REVOKED')),
  activated_at timestamptz not null default now(),
  retired_at   timestamptz
);

-- Exactly one key may issue at any moment.
create unique index if not exists signing_key_single_active
  on signing_key ((true)) where state = 'ACTIVE';

-- ── seat occupancy: the constraint that makes double-booking impossible ─────

create table if not exists seat_occupancy (
  id          uuid primary key default gen_random_uuid(),
  service_key text        not null,
  seat_no     smallint    not null check (seat_no > 0 and seat_no <= 200),
  state       text        not null check (state in ('HELD','CONFIRMED','RELEASED')),
  hold_token  uuid,
  booking_id  uuid,
  expires_at  timestamptz,
  created_at  timestamptz not null default now(),
  constraint held_rows_expire check (
    (state = 'HELD' and expires_at is not null) or
    (state <> 'HELD' and expires_at is null)
  )
);

-- These two indexes are the entire safety property. Application code can be
-- raced; a partial unique index cannot.
create unique index if not exists seat_confirmed_unique
  on seat_occupancy (service_key, seat_no) where state = 'CONFIRMED';

create unique index if not exists seat_held_unique
  on seat_occupancy (service_key, seat_no) where state = 'HELD';

create index if not exists seat_hold_expiry on seat_occupancy (expires_at) where state = 'HELD';
create index if not exists seat_by_booking  on seat_occupancy (booking_id);
create index if not exists seat_by_service  on seat_occupancy (service_key);

-- ── bookings ───────────────────────────────────────────────────────────────

create table if not exists booking (
  id             uuid primary key default gen_random_uuid(),
  locator        char(6) not null unique,
  status         text not null default 'CONFIRMED' check (status in ('CONFIRMED','REFUNDED','CHANGED')),
  contact_phone  text not null,
  contact_email  text,
  currency       char(3) not null default 'TZS',
  total_minor    bigint not null check (total_minor >= 0),
  fare_minor     bigint not null check (fare_minor >= 0),
  tax_minor      bigint not null check (tax_minor >= 0),
  fee_minor      bigint not null check (fee_minor >= 0),
  quote_snapshot jsonb  not null,
  segments       jsonb  not null,
  flexible       boolean not null default false,
  issued_at      timestamptz not null default now(),
  constraint locator_charset check (locator ~ '^[ACDEFGHJKMNPQRTUVWXYZ2346789]{6}$')
);

create index if not exists booking_by_phone on booking (contact_phone);

create table if not exists booking_passenger (
  id              uuid primary key default gen_random_uuid(),
  booking_id      uuid not null references booking(id) on delete cascade,
  pax_index       smallint not null,
  given_name      text not null,
  family_name     text not null,
  pax_type        text not null check (pax_type in ('ADT','CHD','INF','SNR')),
  nationality     char(2) not null,
  document_type   text not null check (document_type in ('NID','PP','VID','DL')),
  -- Regulated data: AES-256-GCM ciphertext produced by the Edge Function.
  -- Plaintext never reaches this database.
  document_cipher bytea not null,
  document_index  text  not null,   -- blind index, for equality lookup only
  unique (booking_id, pax_index)
);

create index if not exists passenger_family_name on booking_passenger (lower(family_name));
create index if not exists passenger_doc_index   on booking_passenger (document_index);

create table if not exists ticket (
  id             uuid primary key default gen_random_uuid(),
  booking_id     uuid not null references booking(id) on delete cascade,
  passenger_id   uuid not null references booking_passenger(id) on delete cascade,
  leg_index      smallint not null,
  ticket_number  char(13) not null unique,
  seat_no        smallint not null,
  -- Immutable: a reprint must be byte-identical or the gate rejects it.
  barcode        text not null,
  signing_key_id char(2) not null references signing_key(id),
  issued_at      timestamptz not null default now(),
  constraint ticket_number_digits check (ticket_number ~ '^\d{13}$')
);

create index if not exists ticket_by_booking on ticket (booking_id);

-- ── payments: idempotency as a constraint, not a convention ─────────────────

create table if not exists payment (
  id              uuid primary key default gen_random_uuid(),
  booking_id      uuid references booking(id),
  idempotency_key text not null unique,
  method          text not null,
  amount_minor    bigint not null check (amount_minor > 0),
  currency        char(3) not null,
  state           text not null check (state in ('PENDING','AUTHORIZED','CAPTURED','FAILED','REFUNDED')),
  provider_ref    text,
  failure_code    text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists payment_event (
  id           bigserial primary key,
  payment_id   uuid references payment(id),
  provider_ref text,
  event_type   text not null,
  payload      jsonb not null,
  signature_ok boolean not null,
  received_at  timestamptz not null default now(),
  processed_at timestamptz,
  unique (provider_ref, event_type)
);

-- ── gate operations ────────────────────────────────────────────────────────

create table if not exists gate_device (
  id              uuid primary key default gen_random_uuid(),
  label           text not null,
  station_code    char(3) references station(code),
  attestation_ref text,
  last_sync_at    timestamptz,
  revoked_at      timestamptz
);

create table if not exists boarding_scan (
  id          uuid primary key default gen_random_uuid(),
  device_id   uuid references gate_device(id),
  service_key text not null,
  locator     char(6),
  seat_no     smallint,
  result_code text not null,
  accepted    boolean not null,
  scanned_at  timestamptz not null,
  synced_at   timestamptz not null default now(),
  -- The device's own idea of the event is the identity, so an offline device
  -- may resend the same batch without creating duplicates.
  unique (device_id, service_key, scanned_at, locator)
);

create unique index if not exists boarding_once_per_ticket
  on boarding_scan (service_key, locator, seat_no) where accepted;

-- ── disruption ─────────────────────────────────────────────────────────────

create table if not exists disruption (
  id            uuid primary key default gen_random_uuid(),
  service_key   text not null,
  kind          text not null check (kind in ('DELAY','CANCEL')),
  delay_minutes integer not null default 0 check (delay_minutes >= 0),
  reason        text not null,
  declared_by   text not null,
  declared_at   timestamptz not null default now(),
  cleared_at    timestamptz
);

create unique index if not exists disruption_one_open_per_service
  on disruption (service_key) where cleared_at is null;

create table if not exists compensation (
  id            uuid primary key default gen_random_uuid(),
  disruption_id uuid not null references disruption(id) on delete cascade,
  booking_id    uuid not null references booking(id),
  policy_code   text not null,
  amount_minor  bigint not null check (amount_minor >= 0),
  state         text not null check (state in ('DUE','PAID','WAIVED')),
  created_at    timestamptz not null default now(),
  unique (disruption_id, booking_id)
);

-- ── audit: append only ─────────────────────────────────────────────────────

create table if not exists audit_log (
  id      bigserial primary key,
  actor   text not null,
  action  text not null,
  subject text not null,
  detail  jsonb,
  at      timestamptz not null default now()
);

create index if not exists audit_subject on audit_log (subject, at desc);
