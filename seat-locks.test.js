import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryStore } from "../src/lib/memory-store.js";
import {
  claimSeats, confirmHold, extendHold, releaseHold,
  availableSeats, sweepExpiredHolds, HOLD_TTL_MS,
} from "../src/lib/seat-locks.js";

const SERVICE = "svc-dar-ark-0630";
const CAPACITY = 44;

test("a claim grants exactly the seats requested", () => {
  const store = createMemoryStore();
  const r = claimSeats(store, { serviceId: SERVICE, seats: [11, 12] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.seats, [11, 12]);
  assert.deepEqual(store.occupiedSeats(SERVICE).sort((a, b) => a - b), [11, 12]);
});

test("a second claim on a held seat is refused", () => {
  const store = createMemoryStore();
  claimSeats(store, { serviceId: SERVICE, seats: [7] });
  const second = claimSeats(store, { serviceId: SERVICE, seats: [7] });
  assert.equal(second.ok, false);
  assert.equal(second.reason, "SEAT_TAKEN");
  assert.equal(second.seatNo, 7);
});

test("THE RACE: twenty concurrent claims on one seat produce exactly one winner", async () => {
  const store = createMemoryStore();

  // Force the worst case explicitly: every caller completes its availability
  // read *before* any caller writes. This is the exact check-then-write window
  // that v5's client-side hold could not close.
  const views = await Promise.all(
    Array.from({ length: 20 }, () => store.readAvailability(SERVICE, CAPACITY))
  );
  for (const free of views) {
    assert.ok(free.includes(12), "every caller must observe the seat as free");
  }

  // Now they all commit against the same stale view.
  const results = await Promise.all(
    views.map(async () => claimSeats(store, { serviceId: SERVICE, seats: [12] }))
  );
  const winners = results.filter((r) => r.ok);
  const losers = results.filter((r) => !r.ok);

  assert.equal(winners.length, 1, "exactly one caller may hold the seat");
  assert.equal(losers.length, 19);
  for (const l of losers) {
    assert.equal(l.reason, "SEAT_TAKEN");
    assert.equal(l.seatNo, 12);
  }
  assert.equal(store.occupiedSeats(SERVICE).filter((s) => s === 12).length, 1);
});

test("THE RACE: overlapping baskets never leave a seat double-held", async () => {
  const store = createMemoryStore();
  const baskets = [[3, 4, 5], [5, 6, 7], [7, 8, 9], [1, 2, 3]];

  const results = await Promise.all(baskets.map(async (seats) => {
    await store.readAvailability(SERVICE, CAPACITY);
    return claimSeats(store, { serviceId: SERVICE, seats });
  }));

  const occupied = store.occupiedSeats(SERVICE);
  assert.equal(new Set(occupied).size, occupied.length, "a seat was held twice");

  // Every granted seat is accounted for, and no loser left seats stranded.
  const granted = results.filter((r) => r.ok).flatMap((r) => r.seats);
  assert.deepEqual(occupied.sort((a, b) => a - b), granted.sort((a, b) => a - b));
});

test("a failed basket releases the seats it had already taken", () => {
  const store = createMemoryStore();
  claimSeats(store, { serviceId: SERVICE, seats: [30] });

  // 28 and 29 succeed, 30 clashes; nothing may survive.
  const r = claimSeats(store, { serviceId: SERVICE, seats: [28, 29, 30] });
  assert.equal(r.ok, false);
  assert.deepEqual(store.occupiedSeats(SERVICE), [30], "partial hold was stranded");
});

test("an expired hold stops conflicting without a sweeper", () => {
  const store = createMemoryStore();
  const t0 = Date.now();
  claimSeats(store, { serviceId: SERVICE, seats: [20], now: t0 });

  const tooSoon = claimSeats(store, { serviceId: SERVICE, seats: [20], now: t0 + HOLD_TTL_MS - 1000 });
  assert.equal(tooSoon.ok, false);

  const afterExpiry = claimSeats(store, { serviceId: SERVICE, seats: [20], now: t0 + HOLD_TTL_MS + 1 });
  assert.equal(afterExpiry.ok, true, "expired hold still blocking");
});

test("a confirmed seat is occupied forever", () => {
  const store = createMemoryStore();
  const t0 = Date.now();
  const hold = claimSeats(store, { serviceId: SERVICE, seats: [15], now: t0 });
  confirmHold(store, { holdToken: hold.holdToken, bookingId: "bk-1", now: t0 });

  const later = claimSeats(store, { serviceId: SERVICE, seats: [15], now: t0 + 10 * HOLD_TTL_MS });
  assert.equal(later.ok, false, "a sold seat was resold");
});

test("confirming an expired hold is refused", () => {
  const store = createMemoryStore();
  const t0 = Date.now();
  const hold = claimSeats(store, { serviceId: SERVICE, seats: [16], now: t0 });
  const r = confirmHold(store, { holdToken: hold.holdToken, bookingId: "bk-2", now: t0 + HOLD_TTL_MS + 1 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "HOLD_EXPIRED");
});

test("confirmation is idempotent", () => {
  const store = createMemoryStore();
  const hold = claimSeats(store, { serviceId: SERVICE, seats: [17] });
  const first = confirmHold(store, { holdToken: hold.holdToken, bookingId: "bk-3" });
  const second = confirmHold(store, { holdToken: hold.holdToken, bookingId: "bk-3" });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.alreadyConfirmed, true);
  assert.equal(store.occupiedSeats(SERVICE).length, 1);
});

test("extending a live hold moves its expiry", () => {
  const store = createMemoryStore();
  const t0 = Date.now();
  const hold = claimSeats(store, { serviceId: SERVICE, seats: [21], now: t0 });
  const r = extendHold(store, { holdToken: hold.holdToken, now: t0 + 60000 });
  assert.equal(r.ok, true);
  assert.ok(r.expiresAt > hold.expiresAt);
});

test("an expired hold cannot be resurrected", () => {
  const store = createMemoryStore();
  const t0 = Date.now();
  const hold = claimSeats(store, { serviceId: SERVICE, seats: [22], now: t0 });
  const r = extendHold(store, { holdToken: hold.holdToken, now: t0 + HOLD_TTL_MS + 1 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "HOLD_EXPIRED");
});

test("releasing returns the seat to inventory immediately", () => {
  const store = createMemoryStore();
  const hold = claimSeats(store, { serviceId: SERVICE, seats: [25, 26] });
  releaseHold(store, hold.holdToken);
  assert.deepEqual(store.occupiedSeats(SERVICE), []);
  assert.equal(claimSeats(store, { serviceId: SERVICE, seats: [25] }).ok, true);
});

test("availability excludes held and confirmed seats", () => {
  const store = createMemoryStore();
  claimSeats(store, { serviceId: SERVICE, seats: [1, 2] });
  const sold = claimSeats(store, { serviceId: SERVICE, seats: [3] });
  confirmHold(store, { holdToken: sold.holdToken, bookingId: "bk-4" });

  const free = availableSeats(store, { serviceId: SERVICE, capacity: 10 });
  assert.deepEqual(free, [4, 5, 6, 7, 8, 9, 10]);
});

test("holds are scoped to their own service", () => {
  const store = createMemoryStore();
  claimSeats(store, { serviceId: "svc-a", seats: [5] });
  assert.equal(claimSeats(store, { serviceId: "svc-b", seats: [5] }).ok, true);
});

test("the sweeper is housekeeping, not correctness", () => {
  const store = createMemoryStore();
  const t0 = Date.now();
  claimSeats(store, { serviceId: SERVICE, seats: [40, 41], now: t0 });
  const swept = sweepExpiredHolds(store, t0 + HOLD_TTL_MS + 1);
  assert.equal(swept, 2);
  assert.deepEqual(store.occupiedSeats(SERVICE, t0 + HOLD_TTL_MS + 1), []);
});

test("a duplicate seat inside one basket is rejected outright", () => {
  const store = createMemoryStore();
  assert.throws(() => claimSeats(store, { serviceId: SERVICE, seats: [9, 9] }), /duplicate seat/);
});
