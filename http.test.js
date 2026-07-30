/**
 * Integration tests. These start a real listener and make real requests over a
 * socket, so the transport, the pipeline and the routes are all exercised.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/http/app.js";
import { createServer } from "../src/http/server.js";
import { createMemoryStore } from "../src/lib/memory-store.js";
import { createMemoryBookingStore } from "../src/lib/booking-store.js";
import { createSigningService } from "../src/lib/signing.js";
import { createPiiCipher } from "../src/lib/pii.js";
import { createLogger } from "../src/lib/logger.js";
import { searchServices, todayISO, parseAndVerify } from "@safaritiketi/domain";

const GATE_TOKEN = "g".repeat(40);
let base, shutdown, seatStore, bookingStore, signing;

const silent = { write() {} };

before(async () => {
  seatStore = createMemoryStore();
  bookingStore = createMemoryBookingStore();
  signing = createSigningService([{ id: "K2", state: "ACTIVE", secret: "s".repeat(40) }]);

  const app = createApp({
    seatStore, bookingStore, signing,
    pii: createPiiCipher(Buffer.alloc(32, 5).toString("base64")),
    config: { seatHoldTtlMs: 600000, gateProvisioningToken: GATE_TOKEN },
    logger: createLogger({ level: "error", stream: silent }),
  });

  const s = createServer(app, { logger: null, maxBodyBytes: 64 * 1024 });
  await new Promise((r) => s.server.listen(0, r));
  base = `http://127.0.0.1:${s.server.address().port}`;
  shutdown = s.shutdown;
});

after(async () => { await shutdown(0); });

const call = async (method, path, { body, headers } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
};

const service = () => searchServices({ from: "DAR", to: "ARK", date: todayISO() })[0];

const passenger = (i = 0) => ({
  firstName: ["Asha", "Baraka", "Neema"][i], lastName: "Mbwana", type: "ADT",
  documentType: "NID", documentNumber: `1990010123${i}`, nationality: "TZ",
});

/* ── health and shape ── */

test("liveness responds", async () => {
  const r = await call("GET", "/health");
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "ok");
});

test("readiness actually touches its dependencies", async () => {
  const r = await call("GET", "/ready");
  assert.equal(r.status, 200);
  assert.equal(r.body.checks.seatStore, "ok");
});

test("every response carries a request id", async () => {
  const r = await call("GET", "/health");
  assert.match(r.headers.get("x-request-id"), /[0-9a-f-]{36}/);
});

test("a supplied request id is echoed for tracing", async () => {
  const r = await call("GET", "/health", { headers: { "x-request-id": "trace-me-123" } });
  assert.equal(r.headers.get("x-request-id"), "trace-me-123");
});

test("an unknown route returns problem+json", async () => {
  const r = await call("GET", "/v1/nope");
  assert.equal(r.status, 404);
  assert.match(r.headers.get("content-type"), /application\/problem\+json/);
  assert.match(r.body.type, /problems\/not-found/);
  assert.equal(r.body.status, 404);
});

test("a wrong method is distinguished from a missing route", async () => {
  const r = await call("GET", "/v1/holds");
  assert.equal(r.status, 405);
});

test("malformed JSON is rejected before reaching a route", async () => {
  const res = await fetch(base + "/v1/holds", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{not json",
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).title, /Invalid JSON/);
});

test("the transport refuses an oversized body rather than buffering it", async () => {
  const res = await fetch(base + "/v1/holds", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ serviceId: "x", pad: "A".repeat(80_000) }),
  });
  assert.equal(res.status, 413, "transport bound");
});

/* ── catalogue ── */

test("services require complete query parameters", async () => {
  assert.equal((await call("GET", "/v1/services?from=DAR")).status, 400);
  assert.equal((await call("GET", "/v1/services?from=DAR&to=DAR&date=2026-08-01")).status, 400);
  assert.equal((await call("GET", "/v1/services?from=XXX&to=ARK&date=2026-08-01")).status, 400);
  assert.equal((await call("GET", "/v1/services?from=DAR&to=ARK&date=01-08-2026")).status, 400);
});

test("a valid search returns services", async () => {
  const r = await call("GET", `/v1/services?from=DAR&to=ARK&date=${todayISO()}`);
  assert.equal(r.status, 200);
  assert.ok(r.body.services.length > 0);
  assert.ok(r.body.services[0].serviceNo);
});

/* ── holds ── */

test("a hold is granted and reported as occupied", async () => {
  const r = await call("POST", "/v1/holds", { body: { serviceId: "svc-http-1", seats: [4, 5] } });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.seats, [4, 5]);
  assert.ok(Date.parse(r.body.expiresAt) > Date.now());

  const avail = await call("GET", "/v1/services/svc-http-1/availability?capacity=6");
  assert.deepEqual(avail.body.occupied, [4, 5]);
});

test("a clashing hold returns 409 naming the seat", async () => {
  await call("POST", "/v1/holds", { body: { serviceId: "svc-http-2", seats: [9] } });
  const r = await call("POST", "/v1/holds", { body: { serviceId: "svc-http-2", seats: [9] } });
  assert.equal(r.status, 409);
  assert.equal(r.body.seatNo, 9);
  assert.match(r.body.type, /seat-taken/);
});

test("hold requests are validated", async () => {
  assert.equal((await call("POST", "/v1/holds", { body: {} })).status, 400);
  assert.equal((await call("POST", "/v1/holds", { body: { serviceId: "s", seats: [] } })).status, 400);
  assert.equal((await call("POST", "/v1/holds", { body: { serviceId: "s", seats: [1, 1] } })).status, 400);
  assert.equal((await call("POST", "/v1/holds", { body: { serviceId: "s", seats: [1, 2, 3, 4, 5, 6, 7] } })).status, 400);
  assert.equal((await call("POST", "/v1/holds", { body: { serviceId: "s", seats: [0] } })).status, 400);
});

test("a released hold frees the seats immediately", async () => {
  const held = await call("POST", "/v1/holds", { body: { serviceId: "svc-http-3", seats: [2] } });
  const del = await call("DELETE", `/v1/holds/${held.body.holdToken}`);
  assert.equal(del.status, 204);
  const again = await call("POST", "/v1/holds", { body: { serviceId: "svc-http-3", seats: [2] } });
  assert.equal(again.status, 201);
});

test("an expired or unknown hold cannot be extended", async () => {
  const r = await call("POST", "/v1/holds/no-such-token/extend");
  assert.equal(r.status, 409);
});

/* ── issuing ── */

const bookOnce = async (idemKey, serviceId = "svc-book-1", seats = [21]) => {
  const held = await call("POST", "/v1/holds", { body: { serviceId, seats } });
  return call("POST", "/v1/bookings", {
    headers: { "idempotency-key": idemKey },
    body: {
      holdToken: held.body.holdToken,
      service: service(),
      passengers: seats.map((_, i) => passenger(i)),
      contact: { dial: "+255", phone: "0712345678", email: "a@example.com" },
    },
  });
};

test("a booking is issued with signed tickets", async () => {
  const r = await bookOnce("idem-key-0001");
  assert.equal(r.status, 201);
  assert.match(r.body.locator, /^[ACDEFGHJKMNPQRTUVWXYZ2346789]{6}$/);
  assert.equal(r.body.tickets.length, 1);
  assert.ok(r.body.total > 0);
  assert.equal(r.body.breakdown.reduce((a, b) => a + b.amount, 0), r.body.total);
});

test("the issued barcode verifies against the gate keyring", async () => {
  const r = await bookOnce("idem-key-0002", "svc-book-2", [22]);
  const keyring = signing.gateKeyring();
  assert.equal(parseAndVerify(r.body.barcode, keyring).ok, true);
});

test("the response never contains key material", async () => {
  const r = await bookOnce("idem-key-0003", "svc-book-3", [23]);
  assert.equal(JSON.stringify(r.body).includes("s".repeat(40)), false);
});

test("a booking requires an idempotency key", async () => {
  const held = await call("POST", "/v1/holds", { body: { serviceId: "svc-book-4", seats: [24] } });
  const r = await call("POST", "/v1/bookings", {
    body: { holdToken: held.body.holdToken, service: service(), passengers: [passenger()], contact: { phone: "0712345678" } },
  });
  assert.equal(r.status, 400);
});

test("replaying an idempotency key returns the original booking", async () => {
  const first = await bookOnce("idem-key-0005", "svc-book-5", [25]);
  const replay = await call("POST", "/v1/bookings", {
    headers: { "idempotency-key": "idem-key-0005" },
    body: { holdToken: "irrelevant-on-replay", service: service(), passengers: [passenger()], contact: { phone: "0712345678" } },
  });
  assert.equal(replay.status, 201);
  assert.equal(replay.body.locator, first.body.locator, "a retry created a second booking");
});

test("an expired or unknown hold cannot be converted", async () => {
  const r = await call("POST", "/v1/bookings", {
    headers: { "idempotency-key": "idem-key-0006" },
    body: { holdToken: "gone", service: service(), passengers: [passenger()], contact: { phone: "0712345678" } },
  });
  assert.equal(r.status, 409);
  assert.match(r.body.type, /hold-expired/);
});

test("passenger and contact details are validated", async () => {
  const held = await call("POST", "/v1/holds", { body: { serviceId: "svc-book-7", seats: [27] } });
  const bad = await call("POST", "/v1/bookings", {
    headers: { "idempotency-key": "idem-key-0007" },
    body: {
      holdToken: held.body.holdToken, service: service(),
      passengers: [{ ...passenger(), documentNumber: "x" }],
      contact: { phone: "0712345678" },
    },
  });
  assert.equal(bad.status, 422);
  assert.equal(bad.body.paxIndex, 0);
});

test("a bad phone number is refused", async () => {
  const held = await call("POST", "/v1/holds", { body: { serviceId: "svc-book-8", seats: [28] } });
  const r = await call("POST", "/v1/bookings", {
    headers: { "idempotency-key": "idem-key-0008" },
    body: { holdToken: held.body.holdToken, service: service(), passengers: [passenger()], contact: { phone: "123" } },
  });
  assert.equal(r.status, 422);
});

test("seat count must match passenger count", async () => {
  const held = await call("POST", "/v1/holds", { body: { serviceId: "svc-book-9", seats: [29, 30] } });
  const r = await call("POST", "/v1/bookings", {
    headers: { "idempotency-key": "idem-key-0009" },
    body: { holdToken: held.body.holdToken, service: service(), passengers: [passenger()], contact: { phone: "0712345678" } },
  });
  assert.equal(r.status, 422);
});

/* ── retrieval ── */

test("a booking is retrievable with reference and surname", async () => {
  const issued = await bookOnce("idem-key-0010", "svc-book-10", [31]);
  const r = await call("GET", `/v1/bookings/${issued.body.locator}?surname=Mbwana`);
  assert.equal(r.status, 200);
  assert.equal(r.body.locator, issued.body.locator);
  assert.ok(r.body.refund);
});

test("retrieval never returns a document number", async () => {
  const issued = await bookOnce("idem-key-0011", "svc-book-11", [32]);
  const r = await call("GET", `/v1/bookings/${issued.body.locator}?surname=Mbwana`);
  assert.equal(JSON.stringify(r.body).includes("19900101230"), false);
  assert.equal(r.body.passengers[0].documentNumber, undefined);
});

test("a wrong surname is indistinguishable from a missing booking", async () => {
  const issued = await bookOnce("idem-key-0012", "svc-book-12", [33]);
  const wrong = await call("GET", `/v1/bookings/${issued.body.locator}?surname=Wrong`);
  const missing = await call("GET", "/v1/bookings/ZZZZZZ?surname=Wrong");
  assert.equal(wrong.status, 404);
  assert.deepEqual(wrong.body.detail, missing.body.detail);
});

test("retrieval requires a surname", async () => {
  const issued = await bookOnce("idem-key-0013", "svc-book-13", [34]);
  assert.equal((await call("GET", `/v1/bookings/${issued.body.locator}`)).status, 400);
});

/* ── gate ── */

test("the keyring endpoint requires a bearer token", async () => {
  assert.equal((await call("POST", "/v1/gate/keyring")).status, 401);
  assert.equal((await call("POST", "/v1/gate/keyring", { headers: { authorization: "Bearer wrong" } })).status, 401);
});

test("an authenticated device receives a verification keyring", async () => {
  const r = await call("POST", "/v1/gate/keyring", { headers: { authorization: `Bearer ${GATE_TOKEN}` } });
  assert.equal(r.status, 200);
  assert.ok(r.body.keyring.K2);
  assert.equal(r.body.keys[0].id, "K2");
});

test("scan sync is idempotent for a resending device", async () => {
  const scans = [{ deviceId: "dev-1", serviceNo: "KR412", scannedAt: "2026-08-01T05:30:00Z", locator: "ABCDE2", accepted: true }];
  const first = await call("POST", "/v1/gate/scans", { body: { scans } });
  const again = await call("POST", "/v1/gate/scans", { body: { scans } });
  assert.equal(first.body.stored, 1);
  assert.equal(again.body.stored, 0, "a resent scan was stored twice");
});

test("scan sync validates its payload shape", async () => {
  assert.equal((await call("POST", "/v1/gate/scans", { body: {} })).status, 400);
  assert.equal((await call("POST", "/v1/gate/scans", { body: { scans: "nope" } })).status, 400);
});

test("the route caps a batch even when it fits inside the body limit", async () => {
  const many = Array.from({ length: 501 }, (_, i) => ({
    deviceId: "d", serviceNo: "s", scannedAt: String(i), locator: "L",
  }));
  const payload = JSON.stringify({ scans: many });
  assert.ok(payload.length < 64 * 1024, "fixture must stay under the transport bound to test the route bound");
  const r = await call("POST", "/v1/gate/scans", { body: { scans: many } });
  assert.equal(r.status, 400, "route bound");
  assert.match(r.body.detail, /500 scans/);
});
