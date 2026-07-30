/**
 * Schedule and seat inventory.
 *
 * The generator below is a deterministic stand-in: the same route and date
 * always yields the same services, so a shared link never shows a different
 * world. Replace `searchServices` with the carrier reservation API and nothing
 * above this module changes.
 */
import { STATIONS, CARRIERS, CABINS, TZ_OFFSET, stationBy, roadDistanceKm } from "./catalog.js";
import { addMinutesISO } from "./time.js";
import { seedFrom } from "./documents.js";

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const DEPARTURE_SLOTS = ["05:00", "05:45", "06:30", "07:15", "08:00", "09:30", "11:00", "13:00", "15:00", "17:30", "20:00", "21:30"];

export function seatAttributes(service, seat) {
  const row = Math.ceil(seat / 4), col = ((seat - 1) % 4) + 1;
  return {
    row, col, window: col === 1 || col === 4, aisle: col === 2 || col === 3,
    legroom: row === 1, frontHalf: row <= Math.ceil(service.capacity / 8),
    accessible: service.wheelchairSeats.includes(seat),
    rearmost: row === Math.ceil(service.capacity / 4),
  };
}
export function seatSurchargePct(attrs) {
  let pct = 0;
  if (attrs.legroom) pct += 12; else if (attrs.frontHalf) pct += 5;
  if (attrs.window) pct += 3;
  if (attrs.rearmost) pct -= 5;
  return pct;
}
export function autoPickSeats(service, count) {
  const free = (s) => s <= service.capacity && !service.soldSeats.has(s);
  const rows = Math.ceil(service.capacity / 4), candidates = [];
  for (let r = 0; r < rows; r++) {
    const row = [1, 2, 3, 4].map((c) => r * 4 + c).filter((s) => s <= service.capacity);
    for (let i = 0; i + count <= row.length; i++) {
      const run = row.slice(i, i + count);
      if (run.every(free)) candidates.push({ seats: run, row: r, hasWindow: run.some((s) => seatAttributes(service, s).window) });
    }
  }
  if (candidates.length) {
    candidates.sort((a, b) => (b.hasWindow - a.hasWindow) || (a.row - b.row));
    return candidates[0].seats;
  }
  const all = [];
  for (let s = 1; s <= service.capacity; s++) if (free(s)) all.push(s);
  all.sort((a, b) => {
    const A = seatAttributes(service, a), B = seatAttributes(service, b);
    return (B.window - A.window) || (A.row - B.row);
  });
  return all.slice(0, count).sort((a, b) => a - b);
}
export function seatsAreTogether(seats) {
  if (seats.length < 2) return true;
  const sorted = [...seats].sort((a, b) => a - b);
  return sorted.every((s, i) => i === 0 || (s === sorted[i - 1] + 1 && Math.ceil(s / 4) === Math.ceil(sorted[i - 1] / 4)));
}

export function searchServices({ from, to, date }) {
  const a = stationBy(from), b = stationBy(to);
  if (!a || !b || a === b) return [];
  const distance = roadDistanceKm(a, b);
  const rnd = mulberry32(seedFrom(`${from}${to}${date}`));
  const pool = [...CARRIERS], services = [];
  const count = 4 + Math.floor(rnd() * 5);
  for (let i = 0; i < count && pool.length; i++) {
    const carrier = pool.splice(Math.floor(rnd() * pool.length), 1)[0];
    const cabin = CABINS[carrier.cabin];
    const slot = DEPARTURE_SLOTS[Math.floor(rnd() * DEPARTURE_SLOTS.length)];
    const departISO = `${date}T${slot}:00${TZ_OFFSET}`;
    const cruise = 58 + rnd() * 8, stops = Math.floor(distance / 250);
    const durationMin = Math.round((distance / cruise) * 60 + stops * 20);
    const capacity = 44, loadFactor = 0.15 + rnd() * 0.7;
    const soldCount = Math.round(capacity * loadFactor), sold = new Set();
    while (sold.size < soldCount) sold.add(1 + Math.floor(rnd() * capacity));
    services.push({
      id: `${carrier.code}-${from}${to}-${date}-${slot.replace(":", "")}`,
      serviceNo: `${carrier.code}${100 + Math.floor(rnd() * 800)}`,
      carrier, cabinKey: carrier.cabin, cabin, from, to, distance, departISO,
      arriveISO: addMinutesISO(departISO, durationMin), durationMin, stops, capacity,
      soldSeats: sold, seatsAvailable: capacity - soldCount, loadFactor,
      rating: (4.0 + rnd() * 0.9).toFixed(1), wheelchairSeats: [1, 2],
    });
  }
  return services.sort((x, y) => x.departISO.localeCompare(y.departISO));
}
