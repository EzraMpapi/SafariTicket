/**
 * The HTTP application.
 *
 * Route handlers take a context and return a plain value; the pipeline turns
 * that into a response. Nothing below the transport layer knows about `res`,
 * which is why the whole surface is testable by calling `handle()` directly as
 * well as over a socket.
 */

import { randomUUID } from "node:crypto";
import { createRouter } from "./router.js";
import { ApiError, badRequest, notFound, unauthorized, conflict, internal, unprocessable } from "./errors.js";
import {
  claimSeats, confirmHold, releaseHold, extendHold, availableSeats,
} from "../lib/seat-locks.js";
import {
  searchServices, quoteItinerary, buildBarcodePayload, issueTicketNumber,
  generateRecordLocator, seedFrom, validateBoardingScan, buildManifest,
  disruptionOutcome, validatePromo, toE164, isValidE164, validatePassenger,
  refundQuote, STATIONS, stationBy,
} from "@safaritiketi/domain";

const MAX_BODY_BYTES = 64 * 1024;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Explicit response envelope.
 *
 * An earlier version detected a custom response by checking for a `status`
 * property on the returned value. That silently broke any payload that legitimately
 * contains one — `/health` returns `{status: "ok"}`, which was read as HTTP
 * status "ok" and threw inside writeHead. A unique symbol cannot collide with
 * user data, so the ambiguity is gone by construction rather than by convention.
 */
const RESPONSE = Symbol("http.response");

export function reply(status, body, headers = {}) {
  return { [RESPONSE]: true, status, body, headers };
}

const isResponse = (v) => Boolean(v && typeof v === "object" && v[RESPONSE]);

/* ── request helpers ────────────────────────────────────────────────────── */

function requireString(body, field, { max = 200, pattern, label } = {}) {
  const v = body?.[field];
  if (typeof v !== "string" || v.trim() === "") {
    throw badRequest(`"${field}" is required.`, { field });
  }
  if (v.length > max) throw badRequest(`"${field}" must be at most ${max} characters.`, { field });
  if (pattern && !pattern.test(v)) {
    throw badRequest(`"${field}" is not a valid ${label || field}.`, { field });
  }
  return v;
}

function requireSeatArray(body, field = "seats") {
  const v = body?.[field];
  if (!Array.isArray(v) || v.length === 0) throw badRequest(`"${field}" must be a non-empty array.`, { field });
  if (v.length > 6) throw badRequest("At most six seats may be held at once.", { field });
  for (const s of v) {
    if (!Number.isInteger(s) || s < 1 || s > 200) throw badRequest(`"${field}" contains an invalid seat number.`, { field });
  }
  if (new Set(v).size !== v.length) throw badRequest("Duplicate seat in request.", { field });
  return v;
}

/* ── application ────────────────────────────────────────────────────────── */

/**
 * @param deps.seatStore      seat occupancy port (memory or postgres)
 * @param deps.bookingStore   booking persistence port
 * @param deps.signing        signing service — the only holder of key material
 * @param deps.pii            column cipher for document numbers
 * @param deps.config
 * @param deps.logger
 * @param deps.now            injectable clock, so time-dependent routes are testable
 */
export function createApp(deps) {
  const { seatStore, bookingStore, signing, pii, config, logger, now = () => Date.now() } = deps;
  const router = createRouter();
  const idempotency = new Map();

  /* ── health ── */

  router.get("/health", () => ({ status: "ok", service: "api" }));

  router.get("/ready", async () => {
    // Readiness must actually touch its dependencies. A readiness probe that
    // returns a literal is a liveness probe wearing a disguise.
    try {
      await seatStore.occupiedSeats("readiness-probe", now());
      return { status: "ready", checks: { seatStore: "ok", signingKeys: signing.describe().length } };
    } catch (err) {
      throw new ApiError(503, "not-ready", "Not ready", "A dependency is unavailable.");
    }
  });

  /* ── catalogue ── */

  router.get("/v1/stations", () => ({
    stations: STATIONS.map(({ code, name, terminal }) => ({ code, name, terminal })),
  }));

  router.get("/v1/services", ({ query }) => {
    const from = query.get("from"), to = query.get("to"), date = query.get("date");
    if (!from || !to || !date) throw badRequest("Query parameters from, to and date are required.");
    if (!stationBy(from)) throw badRequest(`Unknown station "${from}".`, { field: "from" });
    if (!stationBy(to)) throw badRequest(`Unknown station "${to}".`, { field: "to" });
    if (from === to) throw badRequest("Origin and destination must differ.");
    if (!ISO_DATE.test(date)) throw badRequest("Parameter date must be YYYY-MM-DD.", { field: "date" });

    const services = searchServices({ from, to, date });
    return {
      services: services.map((s) => ({
        id: s.id, serviceNo: s.serviceNo, carrier: s.carrier.name, cabin: s.cabinKey,
        from: s.from, to: s.to, departAt: s.departISO, arriveAt: s.arriveISO,
        durationMin: s.durationMin, capacity: s.capacity, seatsAvailable: s.seatsAvailable,
      })),
    };
  });

  /* ── seat holds: the server is the authority ── */

  router.post("/v1/holds", async ({ body }) => {
    const serviceId = requireString(body, "serviceId");
    const seats = requireSeatArray(body);

    const result = claimSeats(seatStore, { serviceId, seats, ttlMs: config.seatHoldTtlMs, now: now() });
    if (!result.ok) {
      throw conflict("seat-taken", "Seat no longer available",
        `Seat ${result.seatNo} was taken while you were choosing.`, { seatNo: result.seatNo });
    }
    return reply(201, {
      holdToken: result.holdToken,
      seats: result.seats,
      expiresAt: new Date(result.expiresAt).toISOString(),
    });
  });

  router.post("/v1/holds/:token/extend", ({ params }) => {
    const r = extendHold(seatStore, { holdToken: params.token, ttlMs: config.seatHoldTtlMs, now: now() });
    if (!r.ok) throw conflict("hold-expired", "Hold expired", "Those seats have returned to inventory.");
    return { expiresAt: new Date(r.expiresAt).toISOString(), seats: r.seats };
  });

  router.delete("/v1/holds/:token", ({ params }) => {
    releaseHold(seatStore, params.token);
    return reply(204, undefined);
  });

  router.get("/v1/services/:serviceId/availability", async ({ params, query }) => {
    const capacity = Number(query.get("capacity") || 44);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 200) {
      throw badRequest("Parameter capacity must be between 1 and 200.", { field: "capacity" });
    }
    const taken = new Set(await seatStore.occupiedSeats(params.serviceId, now()));
    const free = [];
    for (let s = 1; s <= capacity; s++) if (!taken.has(s)) free.push(s);
    return { serviceId: params.serviceId, available: free, occupied: [...taken].sort((a, b) => a - b) };
  });

  /* ── issuing ── */

  router.post("/v1/bookings", async ({ body, headers }) => {
    const key = headers["idempotency-key"];
    if (!key || key.length < 8) {
      throw badRequest("An Idempotency-Key header is required for this endpoint.");
    }
    // A retry must return the original result, never a second booking.
    if (idempotency.has(key)) return idempotency.get(key);

    const holdToken = requireString(body, "holdToken");
    const held = seatStore.findByHold(holdToken);
    const rows = typeof held?.then === "function" ? await held : held;
    if (!rows || rows.length === 0) {
      throw conflict("hold-expired", "Hold expired", "Your seats have returned to inventory. Please choose again.");
    }

    const passengers = Array.isArray(body?.passengers) ? body.passengers : [];
    if (passengers.length !== rows.length) {
      throw unprocessable(`Expected ${rows.length} passengers to match ${rows.length} held seats.`);
    }
    for (const [i, p] of passengers.entries()) {
      const errs = validatePassenger(p);
      if (Object.keys(errs).length) {
        throw unprocessable(`Passenger ${i + 1}: ${Object.values(errs)[0]}`, { paxIndex: i, fields: Object.keys(errs) });
      }
    }

    const contact = body?.contact ?? {};
    const phone = toE164(contact.phone, contact.dial || "+255");
    if (!isValidE164(phone)) throw unprocessable("A reachable mobile number is required.", { field: "contact.phone" });

    if (body?.promoCode) {
      const promo = validatePromo(body.promoCode, { paxCount: passengers.length, isReturn: false });
      if (!promo.ok) throw unprocessable(promo.reason, { field: "promoCode" });
    }

    const service = body?.service;
    if (!service?.serviceNo) throw badRequest("A service snapshot is required.", { field: "service" });

    const segments = [{ service, seats: rows.map((r) => r.seatNo).sort((a, b) => a - b) }];
    const quote = quoteItinerary({
      segments, passengers,
      ancillaries: body?.ancillaries ?? {},
      promo: body?.promoCode ?? null,
    });

    const locator = generateRecordLocator();
    const serial = seedFrom(locator + key);
    const tickets = passengers.map((_, i) => issueTicketNumber(service.carrier.numeric, serial + i * 7919));

    // Signed here, on the server, with a key the client has never seen.
    const barcode = buildBarcodePayload(
      { locator, passengers, segments, tickets },
      (message) => signing.sign(message)
    );

    const booking = {
      locator, status: "CONFIRMED",
      issuedAt: new Date(now()).toISOString(),
      segments, tickets, barcode,
      signingKeyId: signing.activeKeyId,
      quote,
      passengers: passengers.map((p) => ({
        ...p,
        // Encrypted before it reaches storage; the plaintext ends here.
        documentNumber: pii.encrypt(p.documentNumber),
        documentIndex: pii.blindIndex(p.documentNumber),
      })),
      contact: { phoneE164: phone, email: contact.email || null },
    };

    const confirmed = confirmHold(seatStore, { holdToken, bookingId: locator, now: now() });
    if (!confirmed.ok) {
      throw conflict("hold-expired", "Hold expired", "Your seats expired during checkout. Please choose again.");
    }

    await bookingStore.save(booking);
    logger.info("booking issued", { locator, seats: segments[0].seats.length, total: quote.total });

    const response = reply(201, {
      locator, issuedAt: booking.issuedAt, status: booking.status,
      tickets, barcode, total: quote.total, currency: quote.currency,
      breakdown: quote.breakdown,
    });
    idempotency.set(key, response);
    return response;
  });

  router.get("/v1/bookings/:locator", async ({ params, query }) => {
    const surname = query.get("surname");
    // Two identifiers, as at any ticket counter. A reference alone is guessable.
    if (!surname) throw badRequest("A surname query parameter is required to retrieve a booking.");

    const booking = await bookingStore.find(params.locator.toUpperCase());
    if (!booking) throw notFound("No booking matches that reference.");
    if (!booking.passengers.some((p) => p.lastName.toLowerCase() === surname.trim().toLowerCase())) {
      // Same response as "not found": confirming a locator exists is a leak.
      throw notFound("No booking matches that reference.");
    }

    return {
      locator: booking.locator, status: booking.status, issuedAt: booking.issuedAt,
      segments: booking.segments, tickets: booking.tickets, barcode: booking.barcode,
      total: booking.quote.total, currency: booking.quote.currency,
      passengers: booking.passengers.map((p) => ({
        firstName: p.firstName, lastName: p.lastName, type: p.type,
        documentType: p.documentType,          // the number itself is never returned
      })),
      refund: refundQuote(booking, now()),
    };
  });

  /* ── gate ── */

  router.post("/v1/gate/keyring", ({ headers }) => {
    const auth = headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token || token !== config.gateProvisioningToken) {
      throw unauthorized("A valid gate provisioning token is required.");
    }
    // Verification secrets, delivered only to an authenticated device.
    return { keyring: signing.gateKeyring(), keys: signing.describe() };
  });

  router.post("/v1/gate/scans", async ({ body }) => {
    const scans = Array.isArray(body?.scans) ? body.scans : null;
    if (!scans) throw badRequest('"scans" must be an array.');
    if (scans.length > 500) throw badRequest("At most 500 scans per sync.");

    // Offline devices resend; accepting the same scan twice must be harmless.
    const accepted = await bookingStore.recordScans(scans);
    logger.info("gate scans synced", { received: scans.length, stored: accepted });
    return { received: scans.length, stored: accepted };
  });

  router.get("/v1/services/:serviceNo/manifest", async ({ params }) => {
    const bookings = await bookingStore.forService(params.serviceNo);
    const service = bookings[0]?.segments.find((s) => s.service.serviceNo === params.serviceNo)?.service;
    if (!service) throw notFound("No manifest for that service.");
    return {
      serviceNo: params.serviceNo,
      manifest: buildManifest(service, bookings).map((row) => ({
        ...row,
        // Masked for the gate screen; the full number is never sent to a device.
        documentNumber: undefined,
      })),
    };
  });

  /* ── pipeline ── */

  async function handle({ method, url, headers = {}, body = null }) {
    const requestId = headers["x-request-id"] || randomUUID();
    const parsed = new URL(url, "http://internal");
    const log = logger.child({ requestId, method, path: parsed.pathname });
    const started = process.hrtime.bigint();

    try {
      const route = router.match(method, parsed.pathname);
      if (!route) throw notFound("No such endpoint.");

      const result = await route.handler({
        params: route.params, query: parsed.searchParams, body, headers, requestId, log,
      });

      const { status, payload, extraHeaders } = isResponse(result)
        ? { status: result.status, payload: result.body, extraHeaders: result.headers }
        : { status: 200, payload: result, extraHeaders: {} };
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      log.info("request completed", { status, ms: Math.round(ms) });
      return { status, body: payload, headers: { "x-request-id": requestId, ...extraHeaders } };
    } catch (err) {
      const apiError = err instanceof ApiError ? err : internal();
      if (!(err instanceof ApiError)) {
        // Unexpected failures are logged in full and reported opaquely.
        log.error("unhandled error", { error: err.message, stack: err.stack });
      } else {
        log.warn("request rejected", { status: apiError.status, type: apiError.type });
      }
      return {
        status: apiError.status,
        body: apiError.toProblem(parsed.pathname),
        headers: { "x-request-id": requestId, "content-type": "application/problem+json" },
      };
    }
  }

  return { handle, router, MAX_BODY_BYTES };
}
