import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeQR, decodeQR, rsEncode, buildBarcodePayload } from "../src/index.js";
import { testSigner, makeBooking, firstService } from "./helpers.js";

test("Reed-Solomon matches the published reference vector", () => {
  const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
  assert.deepEqual(rsEncode(data, 10), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
});

test("payloads round-trip through encode and decode", () => {
  for (const s of ["HELLO", "x".repeat(120), "SAFARI|ACDEF2|DAR>ARK|SEAT 12"]) {
    const q = encodeQR(s);
    assert.equal(decodeQR(q.matrix, q.version, q.mask), s);
  }
});

test("a signed boarding payload survives the round trip", () => {
  const payload = buildBarcodePayload(makeBooking(), testSigner());
  const q = encodeQR(payload);
  assert.equal(decodeQR(q.matrix, q.version, q.mask), payload);
});

test("the worst-case document still fits", () => {
  const svc = firstService("DAR", "SUT");
  const booking = makeBooking({
    service: svc, seats: [1, 2, 3, 4, 5, 6],
    names: Array.from({ length: 6 }, () => ["MWANAIDI", "MOHAMEDI-KIMWERI"]),
  });
  const payload = buildBarcodePayload(booking, testSigner());
  const q = encodeQR(payload);
  assert.ok(q.version <= 10);
  assert.equal(decodeQR(q.matrix, q.version, q.mask), payload);
});

test("every module in the matrix is resolved", () => {
  const q = encodeQR("RESOLVED");
  for (const row of q.matrix) for (const v of row) assert.ok(v === 0 || v === 1);
});

test("structural invariants hold", () => {
  const q = encodeQR("STRUCTURE");
  const n = q.matrix.length;
  assert.equal(n, 21);
  for (const [r, c] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
    assert.equal(q.matrix[r][c], 1, "finder outer ring");
    assert.equal(q.matrix[r + 1][c + 1], 0, "finder inner gap");
    assert.equal(q.matrix[r + 3][c + 3], 1, "finder core");
  }
  assert.equal(q.matrix[n - 8][8], 1, "dark module");
});
