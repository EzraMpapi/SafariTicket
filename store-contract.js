/**
 * The seat occupancy contract.
 *
 * Any store must pass this suite. It is the definition of "substitutable":
 * memory-store and pg-store are interchangeable exactly to the extent that both
 * pass, and no further.
 *
 * Every call is awaited so the same suite works against a synchronous in-memory
 * store and an asynchronous database one.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { claimSeats, confirmHold, extendHold, HOLD_TTL_MS } from "../src/lib/seat-locks.js";

export function runStoreContract(label, makeStore) {
  const SERVICE = "svc-contract-1";

  const claim = async (store, seats, opts = {}) => {
    // claimSeats is sync-by-design against a sync store; awaiting each insert
    // keeps the contract honest for async ones.
    const holdToken = `hold-${Math.random().toString(36).slice(2)}`;
    const now = opts.now ?? Date.now();
    const expiresAt = now + (opts.ttlMs ?? HOLD_TTL_MS);
    const granted = [];
    try {
      for (const seatNo of seats) {
        await store.insertHold({ serviceId: opts.serviceId ?? SERVICE, seatNo, holdToken, expiresAt }, now);
        granted.push(seatNo);
      }
    } catch (err) {
      await store.releaseHold(holdToken);
      if (err.code === "SEAT_TAKEN") return { ok: false, reason: "SEAT_TAKEN", seatNo: err.seatNo };
      throw err;
    }
    return { ok: true, holdToken, seats: granted, expiresAt };
  };

  test(`[${label}] grants a free seat`, async () => {
    const store = await makeStore();
    const r = await claim(store, [11, 12]);
    assert.equal(r.ok, true);
    assert.deepEqual((await store.occupiedSeats(SERVICE)).sort((a, b) => a - b), [11, 12]);
  });

  test(`[${label}] refuses a seat already held`, async () => {
    const store = await makeStore();
    await claim(store, [7]);
    const second = await claim(store, [7]);
    assert.equal(second.ok, false);
    assert.equal(second.seatNo, 7);
  });

  test(`[${label}] rolls back a partially granted basket`, async () => {
    const store = await makeStore();
    await claim(store, [30]);
    const r = await claim(store, [28, 29, 30]);
    assert.equal(r.ok, false);
    assert.deepEqual(await store.occupiedSeats(SERVICE), [30]);
  });

  test(`[${label}] releases an expired hold without a sweeper`, async () => {
    const store = await makeStore();
    const t0 = Date.now();
    await claim(store, [20], { now: t0 });
    assert.equal((await claim(store, [20], { now: t0 + HOLD_TTL_MS - 1000 })).ok, false);
    assert.equal((await claim(store, [20], { now: t0 + HOLD_TTL_MS + 1 })).ok, true);
  });

  test(`[${label}] keeps a confirmed seat occupied forever`, async () => {
    const store = await makeStore();
    const t0 = Date.now();
    const hold = await claim(store, [15], { now: t0 });
    await store.confirmHold(hold.holdToken, "bk-1");
    assert.equal((await claim(store, [15], { now: t0 + 10 * HOLD_TTL_MS })).ok, false);
  });

  test(`[${label}] returns a released seat to inventory`, async () => {
    const store = await makeStore();
    const hold = await claim(store, [25, 26]);
    await store.releaseHold(hold.holdToken);
    assert.deepEqual(await store.occupiedSeats(SERVICE), []);
    assert.equal((await claim(store, [25])).ok, true);
  });

  test(`[${label}] scopes holds to their own service`, async () => {
    const store = await makeStore();
    await claim(store, [5], { serviceId: "svc-a" });
    assert.equal((await claim(store, [5], { serviceId: "svc-b" })).ok, true);
  });

  test(`[${label}] finds the rows belonging to a hold`, async () => {
    const store = await makeStore();
    const hold = await claim(store, [1, 2, 3]);
    const rows = await store.findByHold(hold.holdToken);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((r) => r.seatNo).sort((a, b) => a - b), [1, 2, 3]);
  });

  test(`[${label}] extends an expiry via touchHold`, async () => {
    const store = await makeStore();
    const t0 = Date.now();
    const hold = await claim(store, [21], { now: t0 });
    const [row] = await store.findByHold(hold.holdToken);
    await store.touchHold(row.id, t0 + 2 * HOLD_TTL_MS);
    assert.equal((await claim(store, [21], { now: t0 + HOLD_TTL_MS + 1000 })).ok, false);
  });

  test(`[${label}] reports availability excluding held and confirmed`, async () => {
    const store = await makeStore();
    await claim(store, [1, 2]);
    const sold = await claim(store, [3]);
    await store.confirmHold(sold.holdToken, "bk-2");
    assert.deepEqual(await store.readAvailability(SERVICE, 6), [4, 5, 6]);
  });

  test(`[${label}] sweeps expired holds as housekeeping`, async () => {
    const store = await makeStore();
    const t0 = Date.now();
    await claim(store, [40, 41], { now: t0 });
    assert.equal(await store.sweep(t0 + HOLD_TTL_MS + 1), 2);
  });

  test(`[${label}] THE RACE: one winner from a shared stale view`, async () => {
    const store = await makeStore();
    const views = await Promise.all(
      Array.from({ length: 12 }, () => store.readAvailability(SERVICE, 44))
    );
    for (const free of views) assert.ok(free.includes(12));

    const results = [];
    for (const _ of views) results.push(await claim(store, [12]));
    assert.equal(results.filter((r) => r.ok).length, 1);
  });
}
