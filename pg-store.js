/**
 * PostgreSQL seat occupancy store.
 *
 * Implements the same port as memory-store.js and is proven interchangeable by
 * test/store-contract.js, which both must pass.
 *
 * The safety property is not in this file. It is in the partial unique index in
 * schema.sql. This adapter's only real job is to let the constraint do its work
 * and translate the resulting error into something the domain understands —
 * which is why `insertHold` has no SELECT before its INSERT. Checking first
 * would be slower, would not be safer, and would invite someone to "optimise"
 * the constraint away later.
 */

import { SeatTakenError } from "../lib/seat-locks.js";

const UNIQUE_VIOLATION = "23505";
const HELD_INDEX = "seat_held_unique";
const CONFIRMED_INDEX = "seat_confirmed_unique";

/** Exported for unit testing without a live database. */
export function isSeatConflict(err) {
  if (!err || err.code !== UNIQUE_VIOLATION) return false;
  const constraint = err.constraint || "";
  return constraint === HELD_INDEX || constraint === CONFIRMED_INDEX;
}

const rowToOccupancy = (r) => ({
  id: r.id,
  serviceId: r.service_id,
  seatNo: r.seat_no,
  state: r.state,
  holdToken: r.hold_token,
  bookingId: r.booking_id,
  expiresAt: r.expires_at ? new Date(r.expires_at).getTime() : null,
});

/**
 * @param {{query: (text: string, params?: any[]) => Promise<{rows: any[], rowCount: number}>}} db
 *   A `pg` Pool, Client, or a transaction handle. Passing a transaction handle
 *   is how `confirmHold` is made atomic with the booking insert.
 */
export function createPgStore(db) {
  return {
    /**
     * Atomic by constraint. An expired hold does not conflict because the
     * partial index only covers rows whose state is HELD — and the sweeper, or
     * this statement's own ON CONFLICT handling, clears them.
     */
    async insertHold({ serviceId, seatNo, holdToken, expiresAt }, now = Date.now()) {
      // Clear a lapsed hold on this exact seat first. This is a no-op in the
      // common case and costs one indexed update in the rare one.
      await db.query(
        `UPDATE seat_occupancy
            SET state = 'RELEASED', expires_at = NULL
          WHERE service_id = $1 AND seat_no = $2
            AND state = 'HELD' AND expires_at <= $3`,
        [serviceId, seatNo, new Date(now)]
      );

      try {
        const { rows } = await db.query(
          `INSERT INTO seat_occupancy (service_id, seat_no, state, hold_token, expires_at)
                VALUES ($1, $2, 'HELD', $3, $4)
             RETURNING *`,
          [serviceId, seatNo, holdToken, new Date(expiresAt)]
        );
        return rowToOccupancy(rows[0]);
      } catch (err) {
        if (isSeatConflict(err)) throw new SeatTakenError(seatNo);
        throw err;
      }
    },

    async findByHold(holdToken) {
      const { rows } = await db.query(
        `SELECT * FROM seat_occupancy WHERE hold_token = $1 AND state <> 'RELEASED'`,
        [holdToken]
      );
      return rows.map(rowToOccupancy);
    },

    async touchHold(id, expiresAt) {
      await db.query(
        `UPDATE seat_occupancy SET expires_at = $2 WHERE id = $1 AND state = 'HELD'`,
        [id, new Date(expiresAt)]
      );
    },

    async confirmHold(holdToken, bookingId) {
      await db.query(
        `UPDATE seat_occupancy
            SET state = 'CONFIRMED', booking_id = $2, expires_at = NULL
          WHERE hold_token = $1 AND state = 'HELD'`,
        [holdToken, bookingId]
      );
    },

    async releaseHold(holdToken) {
      const { rowCount } = await db.query(
        `UPDATE seat_occupancy
            SET state = 'RELEASED', expires_at = NULL
          WHERE hold_token = $1 AND state = 'HELD'`,
        [holdToken]
      );
      return rowCount;
    },

    async occupiedSeats(serviceId, now = Date.now()) {
      const { rows } = await db.query(
        `SELECT seat_no FROM seat_occupancy
          WHERE service_id = $1
            AND (state = 'CONFIRMED' OR (state = 'HELD' AND expires_at > $2))
          ORDER BY seat_no`,
        [serviceId, new Date(now)]
      );
      return rows.map((r) => r.seat_no);
    },

    async readAvailability(serviceId, capacity, now = Date.now()) {
      const taken = new Set(await this.occupiedSeats(serviceId, now));
      const free = [];
      for (let s = 1; s <= capacity; s++) if (!taken.has(s)) free.push(s);
      return free;
    },

    async sweep(now = Date.now()) {
      const { rowCount } = await db.query(
        `UPDATE seat_occupancy
            SET state = 'RELEASED', expires_at = NULL
          WHERE state = 'HELD' AND expires_at <= $1`,
        [new Date(now)]
      );
      return rowCount;
    },
  };
}

/**
 * Runs `fn` inside a transaction. Confirming a hold and inserting the booking
 * must share one, or a crash between them leaves a seat sold with no booking
 * attached to it — unrecoverable without manual intervention.
 */
export async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
