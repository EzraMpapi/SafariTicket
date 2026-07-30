import { test } from "node:test";
import assert from "node:assert/strict";
import { createPiiCipher, maskDocumentNumber, DecryptionError } from "../src/lib/pii.js";

const KEY = Buffer.alloc(32, 3).toString("base64");
const OTHER = Buffer.alloc(32, 9).toString("base64");

test("round-trips a document number", () => {
  const c = createPiiCipher(KEY);
  const plain = "19900101-12345-00001-23";
  assert.equal(c.decrypt(c.encrypt(plain)), plain);
});

test("ciphertext reveals nothing about the plaintext", () => {
  const c = createPiiCipher(KEY);
  const blob = c.encrypt("19900101234").toString("utf8");
  assert.equal(blob.includes("19900101234"), false);
});

test("the same plaintext encrypts differently each time", () => {
  const c = createPiiCipher(KEY);
  const a = c.encrypt("SAME").toString("base64");
  const b = c.encrypt("SAME").toString("base64");
  assert.notEqual(a, b, "deterministic ciphertext leaks equality");
});

test("a tampered ciphertext fails rather than returning wrong data", () => {
  const c = createPiiCipher(KEY);
  const buf = c.encrypt("19900101234");
  buf[buf.length - 1] ^= 0xff;
  assert.throws(() => c.decrypt(buf), DecryptionError);
});

test("a tampered auth tag is rejected", () => {
  const c = createPiiCipher(KEY);
  const buf = c.encrypt("19900101234");
  buf[15] ^= 0x01;
  assert.throws(() => c.decrypt(buf), DecryptionError);
});

test("the wrong key cannot decrypt", () => {
  const a = createPiiCipher(KEY), b = createPiiCipher(OTHER);
  assert.throws(() => b.decrypt(a.encrypt("19900101234")), DecryptionError);
});

test("truncated and unversioned blobs are rejected", () => {
  const c = createPiiCipher(KEY);
  assert.throws(() => c.decrypt(Buffer.alloc(4)), /truncated/);
  const buf = c.encrypt("19900101234");
  buf[0] = 99;
  assert.throws(() => c.decrypt(buf), /unsupported ciphertext version/);
});

test("the decryption error does not distinguish wrong key from tampering", () => {
  const a = createPiiCipher(KEY), b = createPiiCipher(OTHER);
  const wrongKey = (() => { try { b.decrypt(a.encrypt("X1234")); } catch (e) { return e.message; } })();
  const tampered = (() => {
    const buf = a.encrypt("X1234"); buf[buf.length - 1] ^= 0xff;
    try { a.decrypt(buf); } catch (e) { return e.message; }
  })();
  assert.equal(wrongKey, tampered);
});

test("the blind index allows lookup without decryption", () => {
  const c = createPiiCipher(KEY);
  assert.equal(c.blindIndex("19900101234"), c.blindIndex("19900101234"));
  assert.notEqual(c.blindIndex("19900101234"), c.blindIndex("19900101235"));
  assert.ok(c.blindIndexMatches("19900101234", c.blindIndex("19900101234")));
});

test("the blind index normalises case and surrounding space", () => {
  const c = createPiiCipher(KEY);
  assert.equal(c.blindIndex("  ab12cd  "), c.blindIndex("AB12CD"));
});

test("the blind index is not derived from the raw encryption key", () => {
  const c = createPiiCipher(KEY);
  const raw = Buffer.from(KEY, "base64").toString("hex");
  assert.notEqual(c.blindIndex("value"), raw);
});

test("a different key yields a different index", () => {
  assert.notEqual(createPiiCipher(KEY).blindIndex("X"), createPiiCipher(OTHER).blindIndex("X"));
});

test("masking keeps only the last four characters", () => {
  assert.equal(maskDocumentNumber("19900101234"), "•••••••1234");
  assert.equal(maskDocumentNumber("ab"), "••");
});

test("a malformed key is refused at construction", () => {
  assert.throws(() => createPiiCipher(Buffer.alloc(16).toString("base64")), /exactly 32 bytes/);
});
