/**
 * Booking persistence port, with an in-memory implementation.
 *
 * The Postgres implementation writes the tables in schema.sql; both satisfy
 * this interface, and the routes never learn which one they were given.
 */

export function createMemoryBookingStore() {
  const bookings = new Map();
  const scans = new Map();

  return {
    async save(booking) {
      bookings.set(booking.locator, booking);
      return booking;
    },

    async find(locator) {
      return bookings.get(locator) ?? null;
    },

    async forService(serviceNo) {
      return [...bookings.values()].filter((b) =>
        b.segments.some((s) => s.service.serviceNo === serviceNo)
      );
    },

    /** Idempotent by scan identity — offline devices resend freely. */
    async recordScans(incoming) {
      let stored = 0;
      for (const s of incoming) {
        const id = `${s.deviceId}:${s.serviceNo}:${s.scannedAt}:${s.locator}`;
        if (scans.has(id)) continue;
        scans.set(id, s);
        stored++;
      }
      return stored;
    },

    async scansFor(serviceNo) {
      return [...scans.values()].filter((s) => s.serviceNo === serviceNo);
    },

    async markRefunded(locator, refund) {
      const b = bookings.get(locator);
      if (!b) return null;
      const updated = { ...b, status: "REFUNDED", refund };
      bookings.set(locator, updated);
      return updated;
    },

    _size: () => bookings.size,
  };
}
