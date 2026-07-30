import { test } from "node:test";
import assert from "node:assert/strict";
import {
  searchServices, autoPickSeats, seatsAreTogether, seatAttributes, seatSurchargePct,
  applyFilters, filterCount, EMPTY_FILTERS, DEPARTURE_WINDOWS,
  roadDistanceKm, STATIONS, todayISO,
} from "../src/index.js";
import { firstService } from "./helpers.js";

test("inventory is deterministic for a route and date", () => {
  const a = searchServices({ from: "ARK", to: "MWZ", date: "2026-09-14" });
  const b = searchServices({ from: "ARK", to: "MWZ", date: "2026-09-14" });
  assert.deepEqual(a.map((s) => s.id), b.map((s) => s.id));
  assert.deepEqual(a.map((s) => s.seatsAvailable), b.map((s) => s.seatsAvailable));
});

test("a route to itself yields nothing", () => {
  assert.deepEqual(searchServices({ from: "DAR", to: "DAR", date: todayISO() }), []);
});

test("every station pair has a plausible road distance", () => {
  for (const a of STATIONS) {
    for (const b of STATIONS) {
      if (a === b) continue;
      const km = roadDistanceKm(a, b);
      assert.ok(km > 5 && km < 3000, `${a.code}-${b.code} = ${km}km`);
    }
  }
});

test("seat geometry matches a 2+2 layout", () => {
  const svc = firstService("DAR", "TGT");
  assert.ok(seatAttributes(svc, 1).window && seatAttributes(svc, 1).legroom);
  assert.ok(seatAttributes(svc, 2).aisle);
  assert.ok(seatAttributes(svc, 3).aisle);
  assert.ok(seatAttributes(svc, 4).window);
  assert.equal(seatAttributes(svc, 5).row, 2);
});

test("auto-pick returns the requested number of unsold seats", () => {
  for (const svc of searchServices({ from: "DAR", to: "ARK", date: todayISO() })) {
    for (const n of [1, 2, 3, 4]) {
      if (svc.seatsAvailable < n) continue;
      const picked = autoPickSeats(svc, n);
      assert.equal(picked.length, n);
      assert.equal(new Set(picked).size, n);
      for (const s of picked) assert.equal(svc.soldSeats.has(s), false);
    }
  }
});

test("auto-pick keeps a pair together on a coach with room", () => {
  const svc = searchServices({ from: "DAR", to: "MOG", date: todayISO() }).find((s) => s.seatsAvailable > 20);
  if (!svc) return;
  assert.ok(seatsAreTogether(autoPickSeats(svc, 2)));
});

test("adjacency respects row boundaries", () => {
  assert.equal(seatsAreTogether([5, 6]), true);
  assert.equal(seatsAreTogether([4, 5]), false);
  assert.equal(seatsAreTogether([12]), true);
  assert.equal(seatsAreTogether([]), true);
});

test("a premium seat carries a surcharge and the rear row a discount", () => {
  const svc = firstService();
  assert.ok(seatSurchargePct(seatAttributes(svc, 1)) > 0);
  assert.ok(seatSurchargePct(seatAttributes(svc, 44)) < 0);
});

test("departure windows partition the day exactly once", () => {
  for (let h = 0; h < 24; h++) {
    assert.equal(DEPARTURE_WINDOWS.filter((w) => w.test(h)).length, 1, `hour ${h}`);
  }
});

test("an empty filter set removes nothing", () => {
  const all = searchServices({ from: "DAR", to: "ARK", date: todayISO() });
  assert.equal(applyFilters(all, EMPTY_FILTERS).length, all.length);
  assert.equal(filterCount(EMPTY_FILTERS), 0);
});

test("a cabin filter never leaks another cabin", () => {
  const all = searchServices({ from: "DAR", to: "ARK", date: todayISO() });
  const cabin = all[0].cabinKey;
  for (const s of applyFilters(all, { ...EMPTY_FILTERS, cabins: [cabin] })) {
    assert.equal(s.cabinKey, cabin);
  }
});

test("filters compose without contradiction", () => {
  const all = searchServices({ from: "DAR", to: "MWZ", date: todayISO() });
  const f = { ...EMPTY_FILTERS, windows: ["early", "day", "evening", "night"] };
  assert.equal(applyFilters(all, f).length, all.length);
});
