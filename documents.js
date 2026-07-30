/**
 * Travel document identifiers and the boarding payload.
 *
 * `buildBarcodePayload` takes a `sign` function rather than a key, so this
 * module can be bundled for the browser without carrying secrets. The browser
 * only ever renders a payload the server already signed.
 */

import { verifyTag, TAG_LENGTH } from "./crypto.js";

/** Excludes 0/O/1/I/L/5/S — the glyph pairs agents misread over a phone. */
const LOCATOR_ALPHABET = "ACDEFGHJKMNPQRTUVWXYZ2346789";
export const LOCATOR_LENGTH = 6;

export function generateRecordLocator(random = defaultRandom) {
  let out = "";
  for (let i = 0; i < LOCATOR_LENGTH; i++) out += LOCATOR_ALPHABET[random() % LOCATOR_ALPHABET.length];
  return out;
}

function defaultRandom() {
  const b = new Uint32Array(1);
  if (globalThis.crypto?.getRandomValues) { globalThis.crypto.getRandomValues(b); return b[0]; }
  return Math.floor(Math.random() * 4294967295);
}

/**
 * 13-digit ticket document: 3-digit carrier code + 9-digit serial + check
 * digit, where the check digit is the first 12 digits modulo 7 — the rule used
 * on interline ticket stock, so downstream systems can validate independently.
 */
export function issueTicketNumber(carrierNumeric, serialSeed) {
  const serial = String(Math.abs(serialSeed) % 1_000_000_000).padStart(9, "0");
  const body = `${carrierNumeric}${serial}`;
  return `${body}${Number(BigInt(body) % 7n)}`;
}

export function validateTicketNumber(tn) {
  return /^\d{13}$/.test(tn) && Number(BigInt(tn.slice(0, 12)) % 7n) === Number(tn[12]);
}

export function seedFrom(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/* ── boarding payload ─────────────────────────────────────────────────────
   Fixed-width and self-delimiting so a handheld scanner can parse it with no
   lookup table, then verify the signature with no network.

   M{n} NAME(20) E LOCATOR(7) [FROM(3) TO(3) CXR(3) SVC(6) JUL(3) SEAT(4) SEQ(2)]×n > KEYID(2) TAG(16)
   ──────────────────────────────────────────────────────────────────────── */

const PAD = (s, n) => String(s).slice(0, n).padEnd(n, " ");
const HEADER_LENGTH = 30;
const LEG_LENGTH = 24;
const KEY_ID_LENGTH = 2;

export function julianDay(iso) {
  const d = new Date(iso);
  return String(Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86400000)).padStart(3, "0");
}

/** The region the signature covers — everything except the tag itself. */
export function buildSignedRegion(booking) {
  const p = booking.passengers[0];
  const head = `M${booking.segments.length}` +
    PAD(`${p.lastName.toUpperCase()}/${p.firstName.toUpperCase()}`, 20) +
    `E${PAD(booking.locator, 7)}`;
  const legs = booking.segments.map((seg, i) =>
    PAD(seg.service.from, 3) + PAD(seg.service.to, 3) + PAD(seg.service.carrier.code, 3) +
    PAD(seg.service.serviceNo, 6) + julianDay(seg.service.departISO) +
    PAD(seg.seats[0], 4) + String(i + 1).padStart(2, "0")
  ).join("");
  return head + legs;
}

/**
 * @param sign {(message: string) => { keyId: string, tag: string }}
 *   Supplied by the signing service. Never a key.
 */
export function buildBarcodePayload(booking, sign) {
  const signed = buildSignedRegion(booking);
  const { keyId, tag } = sign(signed);
  return `${signed}>${keyId}${tag}`;
}

export function parseBarcodePayload(raw) {
  const s = String(raw || "");
  if (!/^M[1-9]/.test(s)) return null;
  const segCount = Number(s[1]);
  if (s[22] !== "E") return null;

  const legs = [];
  let i = HEADER_LENGTH;
  for (let k = 0; k < segCount; k++) {
    if (i + LEG_LENGTH > s.length) return null;
    legs.push({
      from: s.slice(i, i + 3).trim(),
      to: s.slice(i + 3, i + 6).trim(),
      carrier: s.slice(i + 6, i + 9).trim(),
      serviceNo: s.slice(i + 9, i + 15).trim(),
      julian: s.slice(i + 15, i + 18),
      seat: Number(s.slice(i + 18, i + 22).trim()),
      seq: Number(s.slice(i + 22, i + 24)),
    });
    i += LEG_LENGTH;
  }

  if (s[i] !== ">") return null;
  const keyId = s.slice(i + 1, i + 1 + KEY_ID_LENGTH);
  const tag = s.slice(i + 1 + KEY_ID_LENGTH);
  if (tag.length !== TAG_LENGTH) return null;

  return {
    segCount,
    name: s.slice(2, 22).trim(),
    locator: s.slice(23, 30).trim(),
    legs, keyId, tag,
    signed: s.slice(0, i),
  };
}

/** Parse and verify in one call. Used by the gate. */
export function parseAndVerify(raw, keyring) {
  const parsed = parseBarcodePayload(raw);
  if (!parsed) return { ok: false, reason: "BAD_FORMAT", parsed: null };
  const v = verifyTag(keyring, parsed.keyId, parsed.signed, parsed.tag);
  return v.ok ? { ok: true, parsed } : { ok: false, reason: v.reason, parsed };
}
