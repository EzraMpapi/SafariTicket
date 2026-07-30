# Deployment runbook

## Environment

Every variable below is validated at boot. A missing or malformed value exits
`78` (`EX_CONFIG`) with all problems listed at once, so a broken deploy is
diagnosed in one restart rather than four.

| Variable | Required | Notes |
|---|:-:|---|
| `NODE_ENV` | — | `production` enables the placeholder-secret refusal |
| `PORT` | — | Default `8080` |
| `DATABASE_URL` | ✅ | Must be `postgres://`. Unreachable in production exits `75` so the orchestrator retries |
| `DATABASE_POOL_SIZE` | — | Default `10` |
| `SIGNING_KEYS` | ✅ | `<id>:<state>:<secret>` comma-separated. Exactly one `ACTIVE`. Secrets ≥32 chars |
| `PII_ENCRYPTION_KEY` | ✅ | 32 bytes base64. `openssl rand -base64 32` |
| `GATE_PROVISIONING_TOKEN` | ✅ | ≥32 chars. Guards the endpoint that hands out verification keys |
| `SEAT_HOLD_TTL_MS` | — | Default `600000`, bounded 1–60 min |
| `SHUTDOWN_GRACE_MS` | — | Default `15000`. Must exceed your longest request |
| `LOG_LEVEL` | — | `debug` outside production |

Secrets come from a secrets manager, never from the image, never from
`docker-compose.yml`. The compose file's values are development-only and are
rejected by `NODE_ENV=production`.

## Rollout

```bash
npm run migrate        # advisory-locked; safe to run from every instance
npm start
```

Migrations take a Postgres advisory lock, so a rolling deploy that starts five
replicas simultaneously applies each migration exactly once.

**Probes**

| Probe | Path | Behaviour |
|---|---|---|
| Liveness | `/health` | Returns immediately. Restart the container if it fails |
| Readiness | `/ready` | Touches the seat store and signing service. Removes the instance from the load balancer without restarting it |

Readiness deliberately does real work. A readiness probe that returns a literal
is a liveness probe wearing a disguise, and it will happily route traffic to an
instance whose database has gone away.

**Draining.** `SIGTERM` stops accepting connections, lets in-flight requests
finish within `SHUTDOWN_GRACE_MS`, closes the pool, then exits `0`. Set your
orchestrator's termination grace period **above** `SHUTDOWN_GRACE_MS` or it will
`SIGKILL` mid-drain and you will lose exactly the requests this exists to
protect.

## Key rotation

Rotation is routine and must never invalidate a ticket already in a passenger's
pocket.

1. Add the new key as `VERIFY_ONLY` and deploy. Gates now accept it; nothing
   issues under it yet.
2. Wait for every gate device to pull `/v1/gate/keyring`. **Do not skip this** —
   promoting first means tickets that no device can verify.
3. Promote the new key to `ACTIVE` and demote the old one to `VERIFY_ONLY`.
   Deploy. New tickets sign under the new key; old tickets still board.
4. Once the oldest live ticket has travelled — the furthest-out sellable date,
   not an arbitrary window — mark the old key `REVOKED`.

`REVOKED` drops the key from the gate keyring entirely. Use it immediately if a
key is believed compromised, accepting that tickets signed under it stop
boarding and must be reissued.

## Failure modes

| Symptom | Cause | Action |
|---|---|---|
| Exit `78` at boot | Invalid configuration | Read stderr; every problem is listed |
| Exit `75` at boot | Database unreachable in production | Orchestrator retries; check the database first |
| `409 seat-taken` | Two travellers chose the same seat | Correct behaviour. The constraint held |
| `409 hold-expired` at checkout | Traveller exceeded the hold window | Correct. Seats returned to inventory |
| `401` on `/v1/gate/keyring` | Wrong or missing provisioning token | Re-enrol the device; do not widen the check |
| Gate reports `UNKNOWN_KEY` | Device keyring predates a rotation | Device must pull `/v1/gate/keyring` |
| Gate reports `BAD_SIGNATURE` | Forged or altered ticket | Do not board. Escalate to supervisor |
| Gate reports `UNKNOWN_BOOKING` | Device sync is behind | Refuse and sync. Never board on a hunch |

## Operational notes

**Idempotency.** `POST /v1/bookings` requires an `Idempotency-Key`. A retry
returns the original booking rather than issuing a second one. The store is
currently in-process; behind more than one replica it must move to Redis or a
`payment.idempotency_key` lookup, or a retry that lands on another instance will
double-book. **This is a real limitation of the current build.**

**Rate limiting.** Not implemented. `GET /v1/bookings/:locator` takes a locator
plus a surname; without a limiter that pair is brute-forceable at scale. Put a
limiter in front of it before public exposure.

**Logs.** One JSON object per line, with `requestId` on every entry. Sensitive
keys are redacted at the logger, independently of `redactConfig`, so a careless
`logger.info(config)` still cannot leak a secret.

**Backups.** `seat_occupancy` and `booking` are the recoverable core. `ticket.barcode`
is immutable by design — a reprint must be byte-identical or the gate rejects it,
so restoring a booking without its original barcode is not a restore.

## Not ready

| Gap | Consequence |
|---|---|
| Idempotency store is in-process | A retry hitting another replica can double-book |
| No rate limiting | Booking retrieval is brute-forceable |
| Bookings persist to memory, not Postgres | `booking_store` needs the same treatment `seat_store` received |
| No payment provider integration | `payment` and `payment_event` tables exist; no handler writes them |
| No device attestation | A stolen gate device is unrevocable |
| No TLS termination in this repo | Assumed to be handled by the ingress |
| No load testing | Pool sizing and hold TTL are reasoned, not measured |
| No independent security review | 171 self-written tests are evidence of care, not proof |
