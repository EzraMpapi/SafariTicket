import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256, hmacSha256, utf8, toHex, timingSafeEqual, computeTag, verifyTag } from "../src/crypto.js";

test("SHA-256 matches FIPS 180-4 vectors", () => {
  assert.equal(toHex(sha256(utf8(""))), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(toHex(sha256(utf8("abc"))), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(
    toHex(sha256(utf8("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"))),
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
  );
});

test("SHA-256 handles a multi-block message", () => {
  assert.equal(toHex(sha256(utf8("a".repeat(1000000)))),
    "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
});

test("HMAC-SHA256 matches RFC 4231 vectors", () => {
  assert.equal(toHex(hmacSha256(new Uint8Array(20).fill(0x0b), utf8("Hi There"))),
    "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7");
  assert.equal(toHex(hmacSha256(utf8("Jefe"), utf8("what do ya want for nothing?"))),
    "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
  assert.equal(toHex(hmacSha256(new Uint8Array(20).fill(0xaa), new Uint8Array(50).fill(0xdd))),
    "773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe");
});

test("HMAC-SHA256 handles a key longer than the block size", () => {
  assert.equal(
    toHex(hmacSha256(new Uint8Array(131).fill(0xaa), utf8("Test Using Larger Than Block-Size Key - Hash Key First"))),
    "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
  );
});

test("timing-safe compare rejects length and content mismatch", () => {
  assert.equal(timingSafeEqual("abcd", "abcd"), true);
  assert.equal(timingSafeEqual("abcd", "abce"), false);
  assert.equal(timingSafeEqual("abc", "abcd"), false);
  assert.equal(timingSafeEqual(null, "abcd"), false);
});

test("identical messages under different keys produce different tags", () => {
  assert.notEqual(computeTag("key-a", "message"), computeTag("key-b", "message"));
});

test("verifyTag names the reason it refused", () => {
  const ring = { K1: "secret" };
  const tag = computeTag("secret", "msg");
  assert.deepEqual(verifyTag(ring, "K1", "msg", tag), { ok: true });
  assert.equal(verifyTag(ring, "K9", "msg", tag).reason, "UNKNOWN_KEY");
  assert.equal(verifyTag(ring, "K1", "tampered", tag).reason, "BAD_SIGNATURE");
});
