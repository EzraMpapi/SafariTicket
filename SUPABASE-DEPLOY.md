# Deploying to Supabase

Project: `rlhngsrihahhyxnjxrxm`

---

## Read this before you deploy

**Your anon key is safe to ship. It is not safe on its own.**

`VITE_SUPABASE_ANON_KEY` is public by design — Vite inlines it into the bundle
and anyone can read it in devtools. That is expected and fine. It identifies the
project; it authorises nothing.

All authorisation is Row Level Security. `supabase/migrations/…_rls.sql` enables
RLS on every table, revokes the default anon grants, and opens exactly five
functions. **Until that migration is applied, the anon key is full read and
write access to every table in the database.**

So: apply migrations first, then point the app at the project. Not the other way
round.

Separately — the key you pasted is an anon key, so pasting it was harmless. If a
`service_role` key is ever pasted anywhere, treat it as an incident and rotate
it immediately in Dashboard → Settings → API. It bypasses RLS entirely.

---

## Order of operations

### 1. Link the project

```bash
npm install
supabase login
supabase link --project-ref rlhngsrihahhyxnjxrxm
```

### 2. Apply migrations — including RLS

```bash
supabase db push
```

Three migrations, in order:

| File | What it does |
|---|---|
| `…000001_core.sql` | Tables, and the two partial unique indexes that make double-booking impossible |
| `…000002_rls.sql` | **Deny-by-default RLS, plus the five RPCs anon may call** |
| `…000003_issue.sql` | `confirm_booking` — issuance as one transaction. Never granted to anon |

### 3. Set Edge Function secrets

These never appear in the client bundle, in `.env.local`, or in the database.

```bash
# 32+ characters. Exactly one key may be ACTIVE.
supabase secrets set TICKET_SIGNING_KEYS="K2:ACTIVE:$(openssl rand -hex 32)"

# 32 bytes, base64. Encrypts passenger document numbers.
supabase secrets set PII_ENCRYPTION_KEY="$(openssl rand -base64 32)"

# Guards the endpoint that hands verification keys to gate devices.
supabase secrets set GATE_PROVISIONING_TOKEN="$(openssl rand -hex 32)"

# Browser origins permitted to call the functions. Not "*".
supabase secrets set ALLOWED_ORIGINS="https://your-domain.example,http://localhost:5173"
```

**Record `TICKET_SIGNING_KEYS` somewhere you can retrieve it.** Lose it and every
ticket already issued stops verifying at the gate, with no way to reissue them
correctly.

### 4. Deploy the functions

```bash
npm run deploy:functions
```

This vendors `packages/domain` into `supabase/functions/_shared/domain` first —
Supabase deploys only what is inside `supabase/functions`, so a relative import
reaching outside it works locally and fails once deployed.

`issue-ticket` deploys with `--no-verify-jwt` because the passenger flow is
anonymous. Abuse is bounded by requiring a live seat hold, and `hold_seats()`
caps a basket at six seats.

### 5. Run the client

```bash
cp apps/web/.env.example apps/web/.env.local   # values already filled in for this project
npm run dev                                    # http://localhost:5173
```

### 6. Build and ship

```bash
npm run build
```

`vite build` then `scripts/guard-bundle.mjs`, which greps the **built output**
for service-role keys, signing key names and the gate token. It inspects the
bundle rather than the source, because an alias or a stray import can put a
secret in the output that appears in no source file. A leak fails the build.

Deploy `apps/web/dist` to any static host.

---

## Verify the deployment

Work down this list. Each one has failed in a real system somewhere.

```bash
# 1. RLS is on. This must return zero rows — if it returns bookings, stop.
curl "https://rlhngsrihahhyxnjxrxm.supabase.co/rest/v1/booking?select=*" \
  -H "apikey: $ANON_KEY"

# 2. Seat inventory is not directly writable.
curl -X POST "https://rlhngsrihahhyxnjxrxm.supabase.co/rest/v1/seat_occupancy" \
  -H "apikey: $ANON_KEY" -H "content-type: application/json" \
  -d '{"service_key":"x","seat_no":1,"state":"CONFIRMED"}'
# expect: permission denied

# 3. The keyring endpoint refuses an unauthenticated caller.
curl -X POST "https://rlhngsrihahhyxnjxrxm.supabase.co/functions/v1/gate-keyring" \
  -H "apikey: $ANON_KEY"
# expect: 401

# 4. Holds work, and the second caller loses.
curl -X POST "https://rlhngsrihahhyxnjxrxm.supabase.co/rest/v1/rpc/hold_seats" \
  -H "apikey: $ANON_KEY" -H "content-type: application/json" \
  -d '{"p_service_key":"smoke-test","p_seats":[12],"p_ttl_seconds":600}'
# run twice: first 200, second an error naming seat 12
```

| Check | Expected |
|---|---|
| `select * from booking` as anon | zero rows |
| Direct insert into `seat_occupancy` | permission denied |
| `gate-keyring` without a bearer token | 401 |
| `hold_seats` twice on one seat | second call fails |
| Built bundle contains `service_role` | build fails at the guard |
| Ticket QR scanned by a provisioned gate | verifies offline |

---

## Known trade-offs

**`seat_occupancy` keys on `service_key` text, not a foreign key to a service
table.** Inventory is still generated deterministically by
`@safaritiketi/domain`, so there is no catalogue to reference yet. The cost is no
referential integrity against a service list. Seeding a real `service` table is
the next migration.

**Saved travellers stay in `localStorage`.** Syncing identity documents to a
server to power an autofill convenience would create a regulated data store to
solve a small problem.

**No rate limiting.** `issue-ticket` is anonymous and `get_booking` takes a
locator plus a surname. Both need a limiter — Supabase does not provide one at
the function level, so put Cloudflare or an API gateway in front before public
launch.

---

## Not ready for real passengers

| Gap | Consequence |
|---|---|
| No rate limiting | `issue-ticket` and booking retrieval are abusable at scale |
| No real payment provider | The flow records a `CAPTURED` payment without taking money |
| Gate console not deployed | The v5 artifact still holds the only gate UI |
| No device attestation | A stolen gate device is unrevocable |
| Web app untested against a live project | The build is verified; the round trip is not |
| No independent security review | Self-written checks are evidence of care, not proof |

The last two matter most. Everything in this repository has been verified
locally — 171 tests, a bundle guard, a green build — but **nothing here has been
run against your actual Supabase project.** Work the verification checklist
above before you trust it with a booking.
