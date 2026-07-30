/**
 * Server-authoritative seat locking.
 *
 * Through v5 the hold lived in browser state, which means two phones could hold
 * seat 12 and both believe they had it. This module moves the authority to the
 * server, and — more importantly — never relies on a check-then-write.
 *
 * The safety property comes from `store.insertHold` being atomic and refusing a
 * seat that is already occupied. In Postgres that is the partial unique index in
 * schema.sql; here the interface is narrow enough that an in-memory store can
 * provide the identical guarantee for tests and local development.
 *
 * Reading availability first is a courtesy to the UI, not a lock. Two requests
 * may both see a free seat; only one can insert it.
 */

export const HOLD_TTL_MS = 10 * 60 * 1000;

export class SeatTakenError extends Error {
  constructor(seatNo) {
    super(`seat ${seatNo} is no longer available`);
    this.name = "SeatTakenError";
    this.code = "SEAT_TAKEN";
    this.seatNo = seatNo;
  }
}

const uuid = () =>
  globalThis.crypto?.randomUUID?.() ??
  `hold_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

/**
 * Claim a set of seats as one indivisible basket.
 *
 * All-or-nothing: if the fourth seat clashes, the first three are released. A
 * partially-held basket is worse than a failed one — it strands inventory and
 * shows the traveller a price they cannot pay.
 *
 * @param {object} store        seat occupancy port
 * @param {string} serviceId
 * @param {number[]} seats
 * @param {number} [ttlMs]
 * @param {number} [now]
 * @returns {{ok: true, holdToken: string, seats: number[], expiresAt: number}
 *          |{ok: false, reason: 'SEAT_TAKEN', seatNo: number}}
 */
export function claimSeats(store, { serviceId, seats, ttlMs = HOLD_TTL_MS, now = Date.now() }) {
  if (!Array.isArray(seats) || seats.length === 0) {
    throw new TypeError("claimSeats requires at least one seat");
  }
  if (new Set(seats).size !== seats.length) {
    throw new TypeError("duplicate seat in claim");
  }

  const holdToken = uuid();
  const expiresAt = now + ttlMs;

  try {
    for (const seatNo of seats) {
      store.insertHold({ serviceId, seatNo, holdToken, expiresAt }, now);
    }
  } catch (err) {
    // Roll the basket back. In SQL this is the transaction aborting.
    store.releaseHold(holdToken);
    if (err instanceof SeatTakenError) {
      return { ok: false, reason: "SEAT_TAKEN", seatNo: err.seatNo };
    }
    throw err;
  }

  return { ok: true, holdToken, seats: [...seats], expiresAt };
}

/**
 * Extend a live hold. Refuses to resurrect an expired one — the seats have
 * already gone back to inventory and may belong to someone else.
 */
export function extendHold(store, { holdToken, ttlMs = HOLD_TTL_MS, now = Date.now() }) {
  const rows = store.findByHold(holdToken).filter((r) => r.state === "HELD" && r.expiresAt > now);
  if (rows.length === 0) return { ok: false, reason: "HOLD_EXPIRED" };
  const expiresAt = now + ttlMs;
  for (const row of rows) store.touchHold(row.id, expiresAt);
  return { ok: true, expiresAt, seats: rows.map((r) => r.seatNo) };
}

/**
 * Convert a hold into a sale. This is the only transition that makes a seat
 * permanently occupied, and it must happen in the same transaction as the
 * booking insert — a confirmed seat with no booking is unrecoverable.
 */
export function confirmHold(store, { holdToken, bookingId, now = Date.now() }) {
  const rows = store.findByHold(holdToken);
  if (rows.length === 0) return { ok: false, reason: "UNKNOWN_HOLD" };
  if (rows.some((r) => r.state === "HELD" && r.expiresAt <= now)) {
    return { ok: false, reason: "HOLD_EXPIRED" };
  }
  if (rows.every((r) => r.state === "CONFIRMED")) {
    // Idempotent: a retried confirmation is not an error.
    return { ok: true, seats: rows.map((r) => r.seatNo), alreadyConfirmed: true };
  }
  store.confirmHold(holdToken, bookingId);
  return { ok: true, seats: rows.map((r) => r.seatNo) };
}

export function releaseHold(store, holdToken) {
  const released = store.releaseHold(holdToken);
  return { ok: true, released };
}

/** Seats a traveller may still choose. Advisory only — the insert decides. */
export function availableSeats(store, { serviceId, capacity, now = Date.now() }) {
  const taken = new Set(store.occupiedSeats(serviceId, now));
  const free = [];
  for (let s = 1; s <= capacity; s++) if (!taken.has(s)) free.push(s);
  return free;
}

/**
 * Housekeeping only. Expired holds stop conflicting the moment they expire, so
 * correctness never depends on this running.
 */
export function sweepExpiredHolds(store, now = Date.now()) {
  return store.sweep(now);
}
