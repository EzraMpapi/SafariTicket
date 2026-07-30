import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateRecordLocator, issueTicketNumber, validateTicketNumber,
  buildBarcodePayload, buildSignedRegion, parseBarcodePayload, parseAndVerify,
  CARRIERS,
} from "../src/index.js";
import { TEST_KEYRING, testSigner, makeBooking } from "./helpers.js";

test("record locators avoid glyphs that are misread over a phone", () => {
  for (let i = 0; i < 500; i++) {
    assert.doesNotMatch(generateRecordLocator(), /[01ILOS5]/);
  }
});

test("record locators are six characters", () => {
  assert.equal(generateRecordLocator().length, 6);
});

test("ticket numbers satisfy the mod-7 check digit", () => {
  for (const c of CARRIERS) {
    for (let i = 0; i < 50; i++) {
      assert.ok(validateTicketNumber(issueTicketNumber(c.numeric, i * 7919)));
    }
  }
});

test("a corrupted ticket number fails its check digit", () => {
  const tn = issueTicketNumber("401", 12345);
  const wrong = tn.slice(0, 12) + ((Number(tn[12]) + 1) % 10);
  assert.equal(validateTicketNumber(wrong), false);
});

test("barcode payload round-trips through the parser", () => {
  const booking = makeBooking({ locator: "TUVWXY", seats: [7] });
  const parsed = parseBarcodePayload(buildBarcodePayload(booking, testSigner()));
  assert.ok(parsed);
  assert.equal(parsed.locator, "TUVWXY");
  assert.equal(parsed.legs[0].seat, 7);
  assert.equal(parsed.legs[0].serviceNo, booking.segments[0].service.serviceNo);
  assert.equal(parsed.name, "MBWANA/ASHA");
});

test("malformed payloads are rejected rather than guessed at", () => {
  const bad = ["", "hello", "M1short", "M9" + "x".repeat(200), "M1" + " ".repeat(20) + "XLOCATOR", null, undefined];
  for (const b of bad) assert.equal(parseBarcodePayload(b), null, `accepted ${JSON.stringify(b)}`);
});

test("every byte of the signed region is covered by the tag", () => {
  const booking = makeBooking();
  const payload = buildBarcodePayload(booking, testSigner());
  const cut = payload.lastIndexOf(">");
  let mutationsChecked = 0;

  for (let i = 0; i < cut; i++) {
    const replacement = payload[i] === "X" ? "Y" : "X";
    const mutated = payload.slice(0, i) + replacement + payload.slice(i + 1);
    const result = parseAndVerify(mutated, TEST_KEYRING);
    assert.equal(result.ok, false, `byte ${i} was not covered by the signature`);
    mutationsChecked++;
  }
  assert.ok(mutationsChecked > 50, "expected a substantial signed region");
});

test("a tag cannot be transplanted between bookings", () => {
  const a = makeBooking({ locator: "AAAAA2", seats: [5] });
  const b = makeBooking({ locator: "BBBBB3", seats: [6], names: [["Baraka", "Ndosi"]] });
  const payloadA = buildBarcodePayload(a, testSigner());
  const payloadB = buildBarcodePayload(b, testSigner());

  const frankenstein = payloadB.slice(0, payloadB.lastIndexOf(">")) + payloadA.slice(payloadA.lastIndexOf(">"));
  assert.equal(parseAndVerify(frankenstein, TEST_KEYRING).reason, "BAD_SIGNATURE");
});

test("downgrading the key id is refused", () => {
  const booking = makeBooking();
  const payload = buildBarcodePayload(booking, testSigner("T2"));
  const cut = payload.lastIndexOf(">");
  const downgraded = payload.slice(0, cut) + ">T1" + payload.slice(cut + 3);
  assert.equal(parseAndVerify(downgraded, TEST_KEYRING).reason, "BAD_SIGNATURE");
});

test("an unknown key id is refused, not trusted", () => {
  const payload = buildBarcodePayload(makeBooking(), testSigner());
  const cut = payload.lastIndexOf(">");
  const unknown = payload.slice(0, cut) + ">ZZ" + payload.slice(cut + 3);
  assert.equal(parseAndVerify(unknown, TEST_KEYRING).reason, "UNKNOWN_KEY");
});

test("a truncated tag is refused", () => {
  const payload = buildBarcodePayload(makeBooking(), testSigner());
  for (const n of [1, 4, 8, 15]) {
    assert.equal(parseAndVerify(payload.slice(0, -n), TEST_KEYRING).ok, false);
  }
});

test("the signed region excludes the tag itself", () => {
  const booking = makeBooking();
  const signed = buildSignedRegion(booking);
  const payload = buildBarcodePayload(booking, testSigner());
  assert.ok(payload.startsWith(signed));
  assert.equal(payload.slice(signed.length, signed.length + 1), ">");
});
