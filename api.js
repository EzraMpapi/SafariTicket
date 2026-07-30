/**
 * Data layer.
 *
 * Reads and seat holds go straight to Postgres through RPCs that enforce their
 * own rules. Issuance goes through an Edge Function, because it needs a signing
 * key this bundle must never hold.
 *
 * Saved travellers stay in localStorage on purpose: they are a convenience for
 * one device, and syncing identity documents to a server would create a
 * regulated data store to serve a small autofill feature.
 */

import { supabase, functionsUrl, anonHeaders } from "./supabase.js";

class ApiError extends Error {
  constructor(problem, status) {
    super(problem?.detail || problem?.title || "Request failed");
    this.name = "ApiError";
    this.type = problem?.type ?? "";
    this.title = problem?.title;
    this.detail = problem?.detail;
    this.status = status;
  }
}

/** Postgres raises with a detail tag; surface it as a typed error. */
function rpcError(error, fallback) {
  const detail = error?.details || error?.message || "";
  if (detail.includes("SEAT_TAKEN") || /no longer available/.test(detail)) {
    const seat = Number(error?.hint);
    return new ApiError(
      { type: "seat-taken", title: "Seat no longer available",
        detail: Number.isInteger(seat)
          ? `Seat ${seat} was taken while you were choosing.`
          : "One of those seats was taken while you were choosing." },
      409
    );
  }
  if (detail.includes("HOLD_EXPIRED") || /hold has expired/.test(detail)) {
    return new ApiError({ type: "hold-expired", title: "Hold expired",
      detail: "Those seats have returned to inventory." }, 409);
  }
  return new ApiError({ type: "internal", title: "Request failed", detail: fallback }, 500);
}

const TRAVELLERS_KEY = "safaritiketi.travellers.v1";

export const api = {
  /* ── seat inventory ── */

  async occupiedSeats(serviceKey, capacity = 44) {
    const { data, error } = await supabase.rpc("seat_availability", {
      p_service_key: serviceKey, p_capacity: capacity,
    });
    if (error) throw rpcError(error, "Could not read seat availability.");
    const free = new Set(data ?? []);
    const taken = [];
    for (let s = 1; s <= capacity; s++) if (!free.has(s)) taken.push(s);
    return taken;
  },

  async holdSeats(serviceKey, seats, ttlSeconds = 600) {
    const { data, error } = await supabase.rpc("hold_seats", {
      p_service_key: serviceKey, p_seats: seats, p_ttl_seconds: ttlSeconds,
    });
    if (error) throw rpcError(error, "Could not hold those seats.");
    const row = Array.isArray(data) ? data[0] : data;
    return { holdToken: row.hold_token, seats: row.seats, expiresAt: new Date(row.expires_at).getTime() };
  },

  async releaseHold(holdToken) {
    if (!holdToken) return 0;
    const { data, error } = await supabase.rpc("release_hold", { p_hold_token: holdToken });
    if (error) throw rpcError(error, "Could not release the hold.");
    return data ?? 0;
  },

  async extendHold(holdToken, ttlSeconds = 600) {
    const { data, error } = await supabase.rpc("extend_hold", {
      p_hold_token: holdToken, p_ttl_seconds: ttlSeconds,
    });
    if (error) throw rpcError(error, "Could not extend the hold.");
    return new Date(data).getTime();
  },

  /* ── issuance: the server boundary ── */

  async issueTicket({ idempotencyKey, ...payload }) {
    const res = await fetch(`${functionsUrl}/issue-ticket`, {
      method: "POST",
      headers: { ...anonHeaders, "content-type": "application/json", "idempotency-key": idempotencyKey },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(body, res.status);
    return body;
  },

  /* ── retrieval ── */

  async getBooking(locator, surname) {
    const { data, error } = await supabase.rpc("get_booking", {
      p_locator: String(locator).toUpperCase(), p_surname: surname,
    });
    if (error) throw rpcError(error, "Could not retrieve that booking.");
    return data ?? null;  // null covers both "no such locator" and "wrong surname"
  },

  async cancelBooking(locator, surname, refund) {
    const { data, error } = await supabase.rpc("cancel_booking", {
      p_locator: String(locator).toUpperCase(),
      p_surname: surname,
      p_refund_minor: refund.amount,
      p_refund_pct: refund.rule.refundPct,
    });
    if (error) throw rpcError(error, "Could not cancel that booking.");
    if (!data) throw new ApiError({ type: "not-found", title: "Not found",
      detail: "That booking could not be cancelled." }, 404);
    return data;
  },

  /**
   * The Edge Function is the only writer of bookings, so this is a deliberate
   * no-op rather than a missing implementation. Recent bookings are not listed:
   * doing so would need an account, and this flow is anonymous.
   */
  async saveBooking() {},
  async listBookings() { return []; },

  async listDisruptions() {
    const { data, error } = await supabase
      .from("disruption").select("service_key, kind, delay_minutes, reason, declared_at")
      .is("cleared_at", null);
    if (error) return {};
    return Object.fromEntries((data ?? []).map((d) => [
      d.service_key,
      { serviceNo: d.service_key, kind: d.kind, delayMin: d.delay_minutes, reason: d.reason, at: d.declared_at },
    ]));
  },

  /* ── saved travellers: this device only ── */

  async listTravellers() {
    try { return JSON.parse(localStorage.getItem(TRAVELLERS_KEY) ?? "[]"); }
    catch { return []; }
  },

  async saveTraveller(traveller) {
    const all = await api.listTravellers();
    const next = [...all.filter((t) => t.id !== traveller.id), traveller].slice(-8);
    localStorage.setItem(TRAVELLERS_KEY, JSON.stringify(next));
    return traveller;
  },
};
