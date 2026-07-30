import { test } from "node:test";
import assert from "node:assert/strict";
import { validateBoardingScan, buildManifest, buildBarcodePayload, searchServices, todayISO } from "../src/index.js";
import { TEST_KEYRING, testSigner, makeBooking, firstService, insideWindow } from "./helpers.js";

const scan = (payload, over = {}) => {
  const service = over.service ?? firstService();
  return validateBoardingScan(payload, {
    service,
    bookings: over.bookings ?? [],
    scanLog: over.scanLog ?? [],
    keyring: over.keyring ?? TEST_KEYRING,
    now: over.now ?? insideWindow(service),
  });
};

test("a genuine ticket inside the window boards", () => {
  const b = makeBooking();
  const r = scan(buildBarcodePayload(b, testSigner()), { bookings: [b] });
  assert.equal(r.code, "OK");
  assert.equal(r.seat, 5);
  assert.equal(r.passengerName, "MBWANA/ASHA");
});

test("a forged signature is refused", () => {
  const b = makeBooking();
  const forged = buildBarcodePayload(b, testSigner()).slice(0, -16) + "0".repeat(16);
  assert.equal(scan(forged, { bookings: [b] }).code, "BAD_SIGNATURE");
});

test("an empty keyring can display but never approve", () => {
  const b = makeBooking();
  const payload = buildBarcodePayload(b, testSigner());
  assert.equal(scan(payload, { bookings: [b], keyring: {} }).code, "UNKNOWN_KEY");
});

test("an unreadable code is refused", () => {
  assert.equal(scan("NOT-A-TICKET").code, "BAD_FORMAT");
});

test("a validly signed but unknown booking is refused, not assumed", () => {
  const b = makeBooking();
  assert.equal(scan(buildBarcodePayload(b, testSigner()), { bookings: [] }).code, "UNKNOWN_BOOKING");
});

test("a refunded booking is refused", () => {
  const b = makeBooking();
  const payload = buildBarcodePayload(b, testSigner());
  assert.equal(scan(payload, { bookings: [{ ...b, status: "REFUNDED" }] }).code, "CANCELLED");
});

test("a valid ticket for another coach is refused", () => {
  const services = searchServices({ from: "DAR", to: "ARK", date: todayISO() });
  const b = makeBooking({ service: services[0] });
  const payload = buildBarcodePayload(b, testSigner());
  const r = scan(payload, { bookings: [b], service: services[1] });
  assert.equal(r.code, "WRONG_SERVICE");
});

test("the boarding window is enforced at both edges", () => {
  const service = firstService();
  const b = makeBooking({ service });
  const payload = buildBarcodePayload(b, testSigner());
  const departure = new Date(service.departISO).getTime();

  assert.equal(scan(payload, { bookings: [b], service, now: departure - 120 * 60000 }).code, "TOO_EARLY");
  assert.equal(scan(payload, { bookings: [b], service, now: departure - 60 * 60000 + 1000 }).code, "OK");
  assert.equal(scan(payload, { bookings: [b], service, now: departure - 20 * 60000 + 1000 }).code, "GATE_CLOSED");
  assert.equal(scan(payload, { bookings: [b], service, now: departure }).code, "GATE_CLOSED");
});

test("a replayed code cannot board twice", () => {
  const service = firstService();
  const b = makeBooking({ service });
  const payload = buildBarcodePayload(b, testSigner());

  const first = scan(payload, { bookings: [b], service });
  assert.equal(first.code, "OK");

  const log = [{ locator: b.locator, serviceNo: service.serviceNo, accepted: true }];
  const second = scan(payload, { bookings: [b], service, scanLog: log });
  assert.equal(second.code, "ALREADY_BOARDED");
});

test("a rejected scan does not consume the ticket", () => {
  const service = firstService();
  const b = makeBooking({ service });
  const payload = buildBarcodePayload(b, testSigner());
  const log = [{ locator: b.locator, serviceNo: service.serviceNo, accepted: false }];
  assert.equal(scan(payload, { bookings: [b], service, scanLog: log }).code, "OK");
});

test("manifest lists every traveller once, ordered by seat", () => {
  const service = firstService("DAR", "DOD");
  const bookings = [
    makeBooking({ locator: "AAA111", service, seats: [20, 4], names: [["A", "One"], ["B", "Two"]] }),
    makeBooking({ locator: "BBB222", service, seats: [11], names: [["C", "Three"]] }),
  ];
  const m = buildManifest(service, bookings);
  assert.equal(m.length, 3);
  assert.deepEqual(m.map((r) => r.seat), [4, 11, 20]);
  assert.deepEqual(m.map((r) => r.locator), ["AAA111", "BBB222", "AAA111"]);
});

test("manifest ignores bookings on other services", () => {
  const services = searchServices({ from: "DAR", to: "ARK", date: todayISO() });
  const b = makeBooking({ service: services[0] });
  assert.equal(buildManifest(services[1], [b]).length, 0);
});
