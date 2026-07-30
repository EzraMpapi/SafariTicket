/**
 * In-memory seat occupancy store.
 *
 * Exists to give tests and local development the *same* atomicity guarantee as
 * the partial unique index in schema.sql. `insertHold` is synchronous and
 * checks-and-writes without an await inside, which is what makes it atomic on a
 * single-threaded runtime — the analogue of the database doing it under a lock.
 *
 * Reads are async on purpose: they model network latency, so tests can
 * interleave two callers between "looks free" and "insert".
 */

import { SeatTakenError } from "./seat-locks.js";

const occupies = (row, now) =>
  row.state === "CONFIRMED" || (row.state === "HELD" && row.expiresAt > now);

export function createMemoryStore() {
  const rows = [];
  let nextId = 1;

  return {
    /** Atomic. No await between the conflict check and the write. */
    insertHold({ serviceId, seatNo, holdToken, expiresAt }, now = Date.now()) {
      const clash = rows.find(
        (r) => r.serviceId === serviceId && r.seatNo === seatNo && occupies(r, now)
      );
      if (clash) throw new SeatTakenError(seatNo);

      const row = {
        id: nextId++, serviceId, seatNo, holdToken,
        state: "HELD", expiresAt, bookingId: null,
      };
      rows.push(row);
      return row;
    },

    findByHold(holdToken) {
      return rows.filter((r) => r.holdToken === holdToken && r.state !== "RELEASED");
    },

    touchHold(id, expiresAt) {
      const row = rows.find((r) => r.id === id);
      if (row) row.expiresAt = expiresAt;
    },

    confirmHold(holdToken, bookingId) {
      for (const row of rows) {
        if (row.holdToken === holdToken && row.state === "HELD") {
          row.state = "CONFIRMED";
          row.expiresAt = null;
          row.bookingId = bookingId;
        }
      }
    },

    releaseHold(holdToken) {
      let n = 0;
      for (const row of rows) {
        if (row.holdToken === holdToken && row.state === "HELD") { row.state = "RELEASED"; n++; }
      }
      return n;
    },

    occupiedSeats(serviceId, now = Date.now()) {
      return rows.filter((r) => r.serviceId === serviceId && occupies(r, now)).map((r) => r.seatNo);
    },

    /** Async read — models a network round trip so tests can interleave. */
    async readAvailability(serviceId, capacity, now = Date.now()) {
      await new Promise((r) => setTimeout(r, 0));
      const taken = new Set(this.occupiedSeats(serviceId, now));
      const free = [];
      for (let s = 1; s <= capacity; s++) if (!taken.has(s)) free.push(s);
      return free;
    },

    sweep(now = Date.now()) {
      let n = 0;
      for (const row of rows) {
        if (row.state === "HELD" && row.expiresAt <= now) { row.state = "RELEASED"; n++; }
      }
      return n;
    },

    _rows: () => rows,
  };
}
