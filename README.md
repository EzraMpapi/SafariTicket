# SafariTiketi

Intercity coach ticketing for Tanzania: reservation, issuing, boarding and
disruption. **171 tests, 170 passing, 1 skipped.**

## Deploy to Supabase

Full guide: [`docs/SUPABASE-DEPLOY.md`](docs/SUPABASE-DEPLOY.md). Short version:

```bash
npm install
supabase link --project-ref rlhngsrihahhyxnjxrxm

supabase db push                    # 1. tables + RLS + RPCs — do this FIRST
supabase secrets set TICKET_SIGNING_KEYS="K2:ACTIVE:$(openssl rand -hex 32)"
supabase secrets set PII_ENCRYPTION_KEY="$(openssl rand -base64 32)"
supabase secrets set GATE_PROVISIONING_TOKEN="$(openssl rand -hex 32)"
npm run deploy:functions            # 2. issue-ticket + gate-keyring

cp apps/web/.env.example apps/web/.env.local
npm run dev                         # 3. http://localhost:5173
npm run build                       # vite build + client-bundle secret guard
```

> **The anon key is public by design and safe in the bundle — but only because
> every table denies anon by default.** That deny-by-default posture lives in
> `supabase/migrations/…_rls.sql`. Apply the migrations *before* pointing the
> app at real data, or the anon key is full read/write on every table.

## Layout

```
packages/domain     pure logic — no I/O, no framework, no secrets
services/api        standalone Node API (alternative to Supabase; same domain)
supabase/
  migrations/       tables, RLS, and the SECURITY DEFINER RPCs anon may call
  functions/        Edge Functions — the only place signing keys exist
apps/web            passenger client — renders signed payloads, cannot mint them
```

Three boundaries, enforced rather than documented:

- **`packages/domain` holds no secrets.** Signing takes an injected function, never a key.
- **CI greps `packages/` and `apps/` for key material** and fails the build if it appears.
- **`scripts/guard-bundle.mjs` greps the built output**, because an alias or a
  stray import can put a secret in the bundle that appears in no source file.

## Why this is a repository and not a file

The previous iteration was a single 3,400-line React artifact. It was a good
prototype and a bad system, for two specific reasons that no amount of extra
features would have fixed:

**The signing keys were in the browser.** Anyone who opened the network tab
could mint a valid boarding pass. The barcode was cryptographically signed and
completely worthless, because the thing doing the signing was shipped to the
attacker.

**The seat hold lived in client state.** Two phones could hold seat 12 and both
believe they had it. The check and the write were separated by a network round
trip with nothing guarding the gap.

Both are structural. They are fixed by drawing a boundary, not by writing more
code on the wrong side of it.

```
packages/domain     pure logic — no I/O, no framework, no secrets
services/api        HTTP surface, persistence, and the only place keys exist
  src/http          router, problem+json errors, request pipeline
  src/lib           config, logging, signing, PII cipher, seat locks
  src/db            schema, migrations, postgres adapter
apps/web            passenger client — receives signed payloads, cannot mint them
apps/gate           boarding device — holds a verification keyring, works offline
```

CI enforces the boundary directly: a job greps `packages/` and `apps/` for
`SIGNING_KEYS`, `PII_ENCRYPTION_KEY` and `GATE_PROVISIONING_TOKEN` and fails the
build if key material ever appears outside `services/api` again.

---

## The two fixes, and the tests that prove them

### 1. Seat exclusivity is a database constraint

`services/api/src/db/schema.sql` puts a partial unique index on
`seat_occupancy (service_id, seat_no)` for held and confirmed rows. Application
code cannot race a unique index. Two transactions may both pass an availability
check; only one commits.

`seat-locks.js` is written so the safety property lives entirely in an atomic
insert — reading availability first is a courtesy to the UI, never a lock.

The proof is a test that forces the exact race:

```
THE RACE: twenty concurrent claims on one seat produce exactly one winner
```

All twenty callers complete their availability read *before* any of them writes,
so every one of them observes seat 12 as free. Nineteen then fail with
`SEAT_TAKEN`. A second test does the same with overlapping multi-seat baskets and
asserts no seat is ever double-held and no partial basket is stranded.

### 2. Key material never reaches a client

`services/api/src/lib/signing.js` owns every secret. `packages/domain` takes a
`sign` **function**, not a key, so the same document code bundles safely for the
browser.

Rotation is modelled properly — a ticket issued eighteen months ago must still
scan:

| State | Signs new tickets | Boards existing tickets |
|---|:-:|:-:|
| `ACTIVE` | yes | yes |
| `VERIFY_ONLY` | no | yes |
| `REVOKED` | no | no |

Tested: exactly one key may be ACTIVE; rotation does not invalidate live
tickets; a revoked key is dropped from the gate keyring; `describe()` leaks no
secrets. There is also `assertNoKeyMaterial()` — a build-step guard that fails
the client bundle if signing artefacts ever appear in it again.

---

## Module map

| Module | Responsibility |
|---|---|
| `domain/crypto` | SHA-256, HMAC, constant-time compare. **Holds no keys** |
| `domain/qr` | QR Model 2, byte mode, ECC-M, Reed–Solomon over GF(2⁸) |
| `domain/catalog` | Stations, carriers, cabin classes |
| `domain/money` | Integer minor units, ISO 4217. No float reaches a fare |
| `domain/time` | ISO 8601 with explicit +03:00 |
| `domain/documents` | Locators, ticket numbers, barcode build/parse/verify |
| `domain/inventory` | Schedules, seat geometry, auto-pick, adjacency |
| `domain/filters` | Result filtering; windows partition the day exactly once |
| `domain/pricing` | **The single fare authority.** Nothing else computes a total |
| `domain/disruption` | Delay/cancellation states and the compensation table |
| `domain/boarding` | Offline gate validation, manifest |
| `domain/validation` | E.164, ISO 3166, field errors |
| `api/lib/signing` | Key custody, rotation, gate provisioning |
| `api/lib/seat-locks` | Server-authoritative holds |
| `api/db/schema.sql` | Where exclusivity, idempotency and audit are enforced |

---

## Test coverage

**Domain — 71 tests**

| Area | What is asserted |
|---|---|
| crypto | FIPS 180-4 and RFC 4231 vectors, including a multi-block message and an over-length key |
| documents | Mod-7 check digits, locator charset, and a byte-by-byte sweep proving **every** byte of the signed region is covered by the tag |
| documents | Tag transplant, key downgrade, unknown key, truncation — all refused |
| boarding | Every accept and reject path: forged, unknown, cancelled, wrong coach, both window edges, replay |
| pricing | Breakdown sums exactly to total under maximum load; all money integral; VAT on the discounted base; refunds never exceed what was paid |
| inventory | Determinism, seat geometry, auto-pick, adjacency, filter composition |
| disruption | Monotonic compensation, capped at the fare, rebooking excludes the failed coach |
| qr | Reference vector, round-trip, worst-case capacity, structural invariants |

**API — 26 tests**

| Area | What is asserted |
|---|---|
| seat-locks | The twenty-way race, overlapping baskets, all-or-nothing rollback, expiry without a sweeper, idempotent confirmation, service scoping |
| signing | Single active key, rotation safety, revocation, env loading, no secret leakage, client-bundle guard |

---

## HTTP surface

| Method | Path | Notes |
|---|---|---|
| `GET` | `/health` | Liveness |
| `GET` | `/ready` | Readiness — touches the seat store and signing service |
| `GET` | `/v1/stations` | Catalogue |
| `GET` | `/v1/services` | `?from=&to=&date=` |
| `GET` | `/v1/services/:id/availability` | Advisory only; the insert decides |
| `POST` | `/v1/holds` | Server-authoritative seat hold |
| `POST` | `/v1/holds/:token/extend` | Refuses to resurrect an expired hold |
| `DELETE` | `/v1/holds/:token` | Returns seats immediately |
| `POST` | `/v1/bookings` | Requires `Idempotency-Key`. Signs tickets server-side |
| `GET` | `/v1/bookings/:locator` | Requires `?surname=`. Never returns a document number |
| `POST` | `/v1/gate/keyring` | Bearer-authenticated. Verification keys only |
| `POST` | `/v1/gate/scans` | Idempotent offline sync |
| `GET` | `/v1/services/:no/manifest` | Gate manifest |

Errors are RFC 9457 problem+json throughout, with a stable `type` and an
`x-request-id` on every response.

## Operational posture

- **Fail-fast config** — every variable validated at boot; exits `78` listing all
  problems at once, `75` if the database is unreachable in production
- **Structured logs** — one JSON object per line, `requestId` on every entry,
  sensitive keys redacted at the logger independently of `redactConfig`
- **Graceful shutdown** — `SIGTERM` drains in-flight requests, then closes the pool
- **PII at rest** — document numbers AES-256-GCM encrypted with a versioned
  envelope and a derived blind index for lookup without decryption
- **Container** — multi-stage, non-root, `tini` for signal forwarding

See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for the runbook, key-rotation
procedure and failure modes.

## Honest status

Two real defects were found by writing these tests, which is the argument for
having written them.

**A lost dependency.** `encodeQR` used a `utf8` helper that lived in the crypto
section of the monolith and silently vanished when the modules were split. The
QR tests caught it in seconds; in the single file it would have stayed invisible
until a ticket failed to render.

**A response-envelope collision.** The HTTP pipeline detected a custom response
by checking for a `status` property on the returned value — so `/health`,
which returns `{status: "ok"}`, was read as HTTP status `"ok"` and hung the
request. Any payload with a `status` field would have broken. It now uses a
unique symbol, so the ambiguity is gone by construction rather than by
convention.

**Still not production ready:**

| Gap | Consequence |
|---|---|
| Idempotency store is in-process | A retry hitting another replica can double-book |
| No rate limiting | `GET /v1/bookings/:locator` is brute-forceable at scale |
| Bookings persist to memory | `bookingStore` needs the treatment `seatStore` received |
| No payment provider integration | Tables exist; no handler writes them |
| `apps/web` and `apps/gate` not migrated | The v5 artifact is still the working UI |
| No device attestation | A stolen gate device is unrevocable |
| No load testing | Pool size and hold TTL are reasoned, not measured |
| No independent security review | 171 self-written tests are evidence of care, not proof |

The next commit is the Postgres booking store behind the same port the contract
suite already defines — a small change, precisely because the boundary was drawn
first.
