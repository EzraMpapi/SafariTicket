-- SafariTiketi — reservation schema (PostgreSQL 14+)
--
-- The load-bearing idea: seat exclusivity is enforced by a database constraint,
-- not by application code. Application logic can be raced, retried, or deployed
-- twice. A partial unique index cannot. Everything else here follows from that.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─────────────────────────────────────────────────────────────────────────────
-- Reference data
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE station (
  code          char(3) PRIMARY KEY,
  name          text        NOT NULL,
  terminal      text        NOT NULL,
  lat           numeric(8,5) NOT NULL,
  lon           numeric(8,5) NOT NULL,
  active        boolean     NOT NULL DEFAULT true
);

CREATE TABLE carrier (
  code          char(2) PRIMARY KEY,
  numeric_code  char(3) NOT NULL UNIQUE,   -- prefix of every ticket it issues
  name          text    NOT NULL,
  cabin_default text    NOT NULL REFERENCES cabin_class(code) DEFERRABLE INITIALLY DEFERRED,
  on_time_pct   smallint NOT NULL DEFAULT 0 CHECK (on_time_pct BETWEEN 0 AND 100)
);

CREATE TABLE cabin_class (
  code          text PRIMARY KEY,          -- SEMI | LUX | EXEC
  label         text NOT NULL,
  fare_basis    text NOT NULL,
  rate_per_km   integer NOT NULL CHECK (rate_per_km > 0),
  baggage_kg    smallint NOT NULL,
  seat_pitch_cm smallint NOT NULL
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Schedule and inventory
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE service (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_no      text        NOT NULL,
  carrier_code    char(2)     NOT NULL REFERENCES carrier(code),
  cabin_code      text        NOT NULL REFERENCES cabin_class(code),
  origin          char(3)     NOT NULL REFERENCES station(code),
  destination     char(3)     NOT NULL REFERENCES station(code),
  depart_at       timestamptz NOT NULL,
  arrive_at       timestamptz NOT NULL,
  capacity        smallint    NOT NULL CHECK (capacity > 0),
  status          text        NOT NULL DEFAULT 'SCHEDULED'
                              CHECK (status IN ('SCHEDULED','DELAYED','CANCELLED','DEPARTED')),
  CONSTRAINT service_no_per_day UNIQUE (service_no, depart_at),
  CONSTRAINT arrives_after_departure CHECK (arrive_at > depart_at),
  CONSTRAINT distinct_endpoints CHECK (origin <> destination)
);

CREATE INDEX service_route_day ON service (origin, destination, depart_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- Seat occupancy — the constraint that makes double-booking impossible
--
-- One table holds both transient holds and confirmed sales. A seat is occupied
-- if it has a row that is either CONFIRMED, or HELD and not yet expired.
--
-- The partial unique index below is the whole safety property. Two concurrent
-- transactions may both pass an application-level availability check; only one
-- can commit this row. The loser gets a unique violation and is told to pick
-- another seat. No advisory locks, no SELECT FOR UPDATE, no lost updates.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE seat_occupancy (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id    uuid        NOT NULL REFERENCES service(id) ON DELETE CASCADE,
  seat_no       smallint    NOT NULL CHECK (seat_no > 0),
  state         text        NOT NULL CHECK (state IN ('HELD','CONFIRMED','RELEASED')),
  hold_token    uuid,                       -- groups the seats of one basket
  booking_id    uuid,                       -- set when the hold converts
  expires_at    timestamptz,                -- required for HELD, null otherwise
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT held_rows_expire CHECK (
    (state = 'HELD' AND expires_at IS NOT NULL) OR
    (state <> 'HELD' AND expires_at IS NULL)
  )
);

-- A confirmed seat is occupied forever.
CREATE UNIQUE INDEX seat_confirmed_unique
  ON seat_occupancy (service_id, seat_no)
  WHERE state = 'CONFIRMED';

-- A held seat is occupied until it expires. Expired holds stop conflicting
-- automatically, so no sweeper job is required for correctness — only for
-- tidiness.
CREATE UNIQUE INDEX seat_held_unique
  ON seat_occupancy (service_id, seat_no)
  WHERE state = 'HELD';

CREATE INDEX seat_hold_expiry ON seat_occupancy (expires_at) WHERE state = 'HELD';
CREATE INDEX seat_by_booking  ON seat_occupancy (booking_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Bookings
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE booking (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  locator         char(6)     NOT NULL UNIQUE,
  status          text        NOT NULL DEFAULT 'CONFIRMED'
                              CHECK (status IN ('CONFIRMED','REFUNDED','CHANGED')),
  contact_phone   text        NOT NULL,     -- E.164
  contact_email   text,
  currency        char(3)     NOT NULL DEFAULT 'TZS',
  total_minor     bigint      NOT NULL CHECK (total_minor >= 0),
  fare_minor      bigint      NOT NULL CHECK (fare_minor >= 0),
  tax_minor       bigint      NOT NULL CHECK (tax_minor >= 0),
  fee_minor       bigint      NOT NULL CHECK (fee_minor >= 0),
  quote_snapshot  jsonb       NOT NULL,     -- the itemised quote as priced
  flexible        boolean     NOT NULL DEFAULT false,
  issued_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT locator_charset CHECK (locator ~ '^[ACDEFGHJKMNPQRTUVWXYZ2346789]{6}$')
);

CREATE TABLE booking_segment (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id    uuid     NOT NULL REFERENCES booking(id) ON DELETE CASCADE,
  service_id    uuid     NOT NULL REFERENCES service(id),
  leg_index     smallint NOT NULL CHECK (leg_index >= 0),
  direction     text     NOT NULL CHECK (direction IN ('OUT','RET')),
  UNIQUE (booking_id, leg_index)
);

CREATE TABLE booking_passenger (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id      uuid     NOT NULL REFERENCES booking(id) ON DELETE CASCADE,
  pax_index       smallint NOT NULL,
  given_name      text     NOT NULL,
  family_name     text     NOT NULL,
  pax_type        text     NOT NULL CHECK (pax_type IN ('ADT','CHD','INF','SNR')),
  nationality     char(2)  NOT NULL,
  document_type   text     NOT NULL CHECK (document_type IN ('NID','PP','VID','DL')),
  -- Regulated data. Encrypted at rest with a column key; the plaintext never
  -- leaves the API boundary and is never written to logs.
  document_number bytea    NOT NULL,
  UNIQUE (booking_id, pax_index)
);

-- One row per passenger per segment. This is the ticket document.
CREATE TABLE ticket (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id    uuid     NOT NULL REFERENCES booking(id) ON DELETE CASCADE,
  passenger_id  uuid     NOT NULL REFERENCES booking_passenger(id) ON DELETE CASCADE,
  segment_id    uuid     NOT NULL REFERENCES booking_segment(id) ON DELETE CASCADE,
  ticket_number char(13) NOT NULL UNIQUE,
  seat_no       smallint NOT NULL,
  -- The signed payload, stored exactly as issued. Immutable: a reprint must be
  -- byte-identical or the gate will reject it.
  barcode       text     NOT NULL,
  signing_key_id text    NOT NULL REFERENCES signing_key(id) DEFERRABLE INITIALLY DEFERRED,
  issued_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticket_number_check_digit CHECK (ticket_number ~ '^\d{13}$')
);

CREATE INDEX ticket_by_segment ON ticket (segment_id, seat_no);

-- ─────────────────────────────────────────────────────────────────────────────
-- Payments — idempotency is a constraint, not a convention
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE payment (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id      uuid        REFERENCES booking(id),
  idempotency_key text        NOT NULL UNIQUE,   -- a retry cannot double-charge
  method          text        NOT NULL,
  amount_minor    bigint      NOT NULL CHECK (amount_minor > 0),
  currency        char(3)     NOT NULL,
  state           text        NOT NULL CHECK (state IN ('PENDING','AUTHORIZED','CAPTURED','FAILED','REFUNDED')),
  provider_ref    text,
  failure_code    text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Every provider callback is recorded before it is acted on, so a lost or
-- duplicated webhook can be reconciled rather than guessed at.
CREATE TABLE payment_event (
  id            bigserial PRIMARY KEY,
  payment_id    uuid        REFERENCES payment(id),
  provider_ref  text,
  event_type    text        NOT NULL,
  payload       jsonb       NOT NULL,
  signature_ok  boolean     NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz,
  UNIQUE (provider_ref, event_type)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Signing keys — secrets live in the KMS, never in this table
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE signing_key (
  id            char(2) PRIMARY KEY,        -- appears in the barcode
  kms_key_ref   text        NOT NULL,       -- pointer, not material
  algorithm     text        NOT NULL DEFAULT 'HMAC-SHA256-T64',
  state         text        NOT NULL CHECK (state IN ('ACTIVE','VERIFY_ONLY','REVOKED')),
  activated_at  timestamptz NOT NULL DEFAULT now(),
  retired_at    timestamptz
);

-- Exactly one key may be active for issuing at any moment.
CREATE UNIQUE INDEX signing_key_single_active ON signing_key ((true)) WHERE state = 'ACTIVE';

-- ─────────────────────────────────────────────────────────────────────────────
-- Gate operations
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE gate_device (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label           text        NOT NULL,
  station_code    char(3)     NOT NULL REFERENCES station(code),
  attestation_ref text,                      -- device identity, for revocation
  last_sync_at    timestamptz,
  revoked_at      timestamptz
);

-- Scans arrive late and out of order from offline devices, so the primary key
-- is the device's own idea of the event, not arrival order.
CREATE TABLE boarding_scan (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id     uuid        NOT NULL REFERENCES gate_device(id),
  service_id    uuid        NOT NULL REFERENCES service(id),
  locator       char(6),
  seat_no       smallint,
  result_code   text        NOT NULL,
  accepted      boolean     NOT NULL,
  scanned_at    timestamptz NOT NULL,        -- device clock
  synced_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (device_id, service_id, scanned_at, locator)
);

-- The authoritative "this passenger boarded" fact, resolved after sync.
CREATE UNIQUE INDEX boarding_once_per_ticket
  ON boarding_scan (service_id, locator, seat_no)
  WHERE accepted;

-- ─────────────────────────────────────────────────────────────────────────────
-- Disruption
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE disruption (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id    uuid        NOT NULL REFERENCES service(id) ON DELETE CASCADE,
  kind          text        NOT NULL CHECK (kind IN ('DELAY','CANCEL')),
  delay_minutes integer     NOT NULL DEFAULT 0 CHECK (delay_minutes >= 0),
  reason        text        NOT NULL,
  declared_by   text        NOT NULL,
  declared_at   timestamptz NOT NULL DEFAULT now(),
  cleared_at    timestamptz
);

CREATE UNIQUE INDEX disruption_one_open_per_service
  ON disruption (service_id) WHERE cleared_at IS NULL;

CREATE TABLE compensation (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  disruption_id uuid        NOT NULL REFERENCES disruption(id) ON DELETE CASCADE,
  booking_id    uuid        NOT NULL REFERENCES booking(id),
  policy_code   text        NOT NULL,
  amount_minor  bigint      NOT NULL CHECK (amount_minor >= 0),
  state         text        NOT NULL CHECK (state IN ('DUE','PAID','WAIVED')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (disruption_id, booking_id)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Audit — append only
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  actor       text        NOT NULL,      -- user id, device id, or 'system'
  action      text        NOT NULL,
  subject     text        NOT NULL,      -- booking locator, service no, key id
  detail      jsonb,
  at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_subject ON audit_log (subject, at DESC);

REVOKE UPDATE, DELETE ON audit_log FROM PUBLIC;

COMMIT;
