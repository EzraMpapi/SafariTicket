/**
 * Offline boarding authority.
 *
 * Everything here runs on the gate device with no network: parse the payload,
 * verify the signature against an injected keyring, confirm the service and the
 * time window, then check the local scan log.
 *
 * The keyring is a parameter, never a module constant. The gate device holds a
 * verification keyring in its secure store; the passenger web bundle imports
 * this module for its result codes and passes an empty keyring, which means it
 * can display a ticket but can never mint or approve one.
 */

import { parseAndVerify } from "./documents.js";

export const BOARDING_OPENS_MIN = 60;
export const BOARDING_CLOSES_MIN = 20;

export const SCAN_RESULTS = {
  OK: { ok: true, label: "Board", tone: "pass" },
  BAD_FORMAT: { ok: false, label: "Unreadable code", tone: "fail", hint: "Not a SafariTiketi boarding code." },
  BAD_SIGNATURE: { ok: false, label: "Forged or altered", tone: "fail", hint: "Signature does not verify. Do not board. Refer to supervisor." },
  UNKNOWN_KEY: { ok: false, label: "Unknown signing key", tone: "fail", hint: "Issued under a key this device does not hold. Update the device." },
  UNKNOWN_BOOKING: { ok: false, label: "No such booking", tone: "fail", hint: "Signature is valid but no record is held on this device." },
  CANCELLED: { ok: false, label: "Booking cancelled", tone: "fail", hint: "This booking was refunded." },
  WRONG_SERVICE: { ok: false, label: "Wrong service", tone: "warn", hint: "Valid ticket, different coach." },
  TOO_EARLY: { ok: false, label: "Gate not open", tone: "warn", hint: `Boarding opens ${BOARDING_OPENS_MIN} minutes before departure.` },
  GATE_CLOSED: { ok: false, label: "Gate closed", tone: "warn", hint: `Boarding closed ${BOARDING_CLOSES_MIN} minutes before departure.` },
  ALREADY_BOARDED: { ok: false, label: "Already boarded", tone: "warn", hint: "This seat was scanned once already." },
};

const reject = (code, extra = {}) => ({ code, result: SCAN_RESULTS[code], ...extra });

/**
 * @param {string} payload raw string from the scanner
 * @param {object} ctx
 * @param {object} ctx.service   the service this gate is boarding
 * @param {Array}  ctx.bookings  records synced to this device
 * @param {Array}  ctx.scanLog   local scan history
 * @param {object} ctx.keyring   id -> verification secret
 * @param {number} ctx.now       device clock, the only clock that matters here
 */
export function validateBoardingScan(payload, { service, bookings, scanLog = [], keyring = {}, now = Date.now() }) {
  const verified = parseAndVerify(payload, keyring);
  if (!verified.ok) return reject(verified.reason, { parsed: verified.parsed });

  const { parsed } = verified;

  const booking = bookings.find((b) => b.locator === parsed.locator);
  // An unknown booking with a valid signature is refused, not assumed. The
  // device may simply be behind, and guessing at the gate is how people board
  // coaches they have not paid for.
  if (!booking) return reject("UNKNOWN_BOOKING", { parsed });
  if (booking.status === "REFUNDED") return reject("CANCELLED", { parsed, booking });

  const leg = parsed.legs.find((l) => l.serviceNo === service.serviceNo);
  if (!leg) return reject("WRONG_SERVICE", { parsed, booking });

  const departure = new Date(service.departISO).getTime();
  if (now < departure - BOARDING_OPENS_MIN * 60000) return reject("TOO_EARLY", { parsed, booking });
  if (now > departure - BOARDING_CLOSES_MIN * 60000) return reject("GATE_CLOSED", { parsed, booking });

  const alreadyScanned = scanLog.some(
    (s) => s.locator === parsed.locator && s.serviceNo === service.serviceNo && s.accepted
  );
  if (alreadyScanned) return reject("ALREADY_BOARDED", { parsed, booking });

  const segIndex = booking.segments.findIndex((s) => s.service.serviceNo === service.serviceNo);
  return {
    code: "OK",
    result: SCAN_RESULTS.OK,
    parsed,
    booking,
    seat: booking.segments[segIndex]?.seats?.[0],
    passengerName: parsed.name,
    partySize: booking.passengers.length,
  };
}

/** Everyone travelling on a given service, flattened and seat-ordered. */
export function buildManifest(service, bookings) {
  const rows = [];
  for (const b of bookings) {
    const idx = b.segments.findIndex((s) => s.service.serviceNo === service.serviceNo);
    if (idx < 0) continue;
    b.passengers.forEach((p, i) => {
      rows.push({
        locator: b.locator,
        status: b.status,
        name: `${p.lastName.toUpperCase()}/${p.firstName}`,
        paxType: p.type,
        seat: b.segments[idx].seats[i],
        documentType: p.documentType,
        documentNumber: p.documentNumber,
        phone: b.contact?.phoneE164,
      });
    });
  }
  return rows.sort((a, b) => a.seat - b.seat);
}
