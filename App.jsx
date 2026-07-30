/**
 * SafariTiketi — passenger web client.
 *
 * Ported from the single-file prototype. Two structural changes:
 *
 *   1. The domain layer is imported from @safaritiketi/domain rather than
 *      inlined, so fares, documents and QR encoding have one source of truth.
 *
 *   2. Every signing key is gone. The prototype held HMAC secrets in this
 *      bundle, which meant anyone could mint a boarding pass. Signing now
 *      happens in the issue-ticket Edge Function; this client receives a
 *      finished payload it cannot forge, and holds no key material of any kind.
 *
 * The gate console is not in this bundle. It is a separate deployment with a
 * verification keyring, because shipping verification secrets to passengers
 * would defeat the point of signing.
 */

import React, { useState, useEffect, useMemo, useReducer, useRef, useCallback } from "react";
import {
  Bus, MapPin, ArrowLeftRight, Search, Clock, Users, Check, AlertCircle,
  ChevronRight, ChevronLeft, ChevronDown, Share2, Wifi, Tv, BatteryCharging,
  Wind, Star, ShieldCheck, User, ArrowRight, Timer, Globe, Ticket, X, Loader2,
  Armchair, RefreshCw, Luggage, Accessibility, Printer, Wallet, Tag, Umbrella,
  Repeat, Activity, TerminalSquare, Receipt, Info, SlidersHorizontal, Sparkles,
  WifiOff, Zap, TrendingDown, ScanLine, ClipboardList, AlertTriangle, CloudOff,
  UserCheck, Fingerprint, Radio, KeyRound, Bookmark,
} from "lucide-react";

import {
  STATIONS, CARRIERS, CABINS, TZ_OFFSET, stationBy, roadDistanceKm,
  BASE_CURRENCY, FX, Money,
  todayISO, localTime, hourOf, addMinutesISO, addDaysISO, dayOffset,
  formatDate, formatDuration, countdownTo,
  generateRecordLocator, issueTicketNumber, validateTicketNumber, seedFrom,
  parseBarcodePayload,
  searchServices, seatAttributes, seatSurchargePct, autoPickSeats, seatsAreTogether,
  DEPARTURE_WINDOWS, EMPTY_FILTERS, applyFilters, filterCount,
  VAT_RATE, SERVICE_FEE_PER_PAX, RETURN_DISCOUNT_PCT, PAX_TYPES, ANCILLARIES,
  PROMOTIONS, validatePromo, baseFareFor, quoteItinerary, REFUND_RULES, refundQuote,
  DISRUPTION_POLICY, disruptionOutcome, rebookingOptions,
  COUNTRIES, toE164, isValidE164, isValidEmail, isValidName,
  validatePassenger, validateContact, passengerComplete,
  encodeQR,
} from "@safaritiketi/domain";

import { api } from "./lib/api.js";
repo ════════════════════════════════════════════════════════════════ */

/* Persistence lives in ./lib/api.js, which talks to Supabase. Kept under the
   original name so the components below did not need rewriting. */
const repo = api;

/* ═══ i18n ════════════════════════════════════════════════════════════════ */

const STRINGS = {
  en: {
    tagline: "Book. Board. Arrive.",
    heroKicker: "20 stations · 10 carriers · signed tickets",
    heroLead: "Where are you travelling?",
    from: "From", to: "To", date: "Outbound", returnDate: "Return", passengers: "Travellers",
    oneWay: "One way", roundTrip: "Return", searchBuses: "Search services",
    steps: ["Journey", "Service", "Seats", "Details", "Ticket"],
    editSearch: "Change journey", back: "Back", chooseSeats: "Choose seats",
    servicesFound: "services", filters: "Filters", clearFilters: "Clear all",
    sortDepart: "Departure", sortPrice: "Lowest fare", sortDuration: "Fastest",
    cheapest: "Lowest fare", fastest: "Fastest", seatsLeft: "seats left", full: "Sold out",
    chooseForMe: "Choose for me", available: "Available", selected: "Selected", taken: "Taken",
    accessible: "Step-free", window: "Window", aisle: "Aisle", legroom: "Extra legroom",
    premium: "Premium", h: "h", m: "m", km: "km", onTime: "on time",
    continueToDetails: "Continue to details", continueToReturn: "Continue to return leg",
    travellerDetails: "Traveller details", contactDetails: "Contact details", extras: "Extras",
    payment: "Payment", payNow: "Pay", total: "Total", confirmed: "You're booked",
    eticket: "E-ticket", bookAnother: "Book another journey", manage: "Find a booking",
    holdExpires: "Seats held", print: "Print or save PDF", addToWallet: "Add to wallet",
    sendTicket: "Send to phone", retrieve: "Find my booking", locator: "Booking reference",
    surname: "Surname", cancelBooking: "Cancel and refund", refundDue: "Refund due",
    conditions: "Conditions of carriage", outbound: "Outbound", inbound: "Return",
    promoCode: "Promotion code", apply: "Apply", fiscalReceipt: "VAT receipt",
    departsIn: "Departs in", noResults: "No services match those filters",
    noResultsBody: "Loosen a filter, or try a nearby date.", searching: "Finding services",
    offline: "You're offline. Your ticket still works — the code scans without a network.",
    savedTravellers: "Saved travellers", saveTraveller: "Save for next time",
    passengerMode: "Passenger", gateMode: "Gate console",
  },
  sw: {
    tagline: "Kata. Panda. Fika.",
    heroKicker: "Vituo 20 · Kampuni 10 · tiketi zilizosainiwa",
    heroLead: "Unasafiri kwenda wapi?",
    from: "Kutoka", to: "Kwenda", date: "Kwenda", returnDate: "Kurudi", passengers: "Wasafiri",
    oneWay: "Njia moja", roundTrip: "Kwenda na kurudi", searchBuses: "Tafuta safari",
    steps: ["Safari", "Basi", "Viti", "Taarifa", "Tiketi"],
    editSearch: "Badilisha safari", back: "Rudi", chooseSeats: "Chagua viti",
    servicesFound: "safari", filters: "Vichujio", clearFilters: "Ondoa vyote",
    sortDepart: "Kuondoka", sortPrice: "Nauli ndogo", sortDuration: "Haraka zaidi",
    cheapest: "Nauli ndogo", fastest: "Haraka zaidi", seatsLeft: "viti vimebaki", full: "Imejaa",
    chooseForMe: "Nichagulie", available: "Kinapatikana", selected: "Kimechaguliwa", taken: "Kimechukuliwa",
    accessible: "Rahisi kufikika", window: "Dirisha", aisle: "Njia", legroom: "Nafasi ya miguu",
    premium: "Bora", h: "s", m: "d", km: "km", onTime: "kwa wakati",
    continueToDetails: "Endelea kwa taarifa", continueToReturn: "Endelea safari ya kurudi",
    travellerDetails: "Taarifa za msafiri", contactDetails: "Mawasiliano", extras: "Nyongeza",
    payment: "Malipo", payNow: "Lipa", total: "Jumla", confirmed: "Umefanikiwa",
    eticket: "Tiketi ya kielektroniki", bookAnother: "Kata tiketi nyingine", manage: "Pata booking",
    holdExpires: "Viti vimehifadhiwa", print: "Chapisha au hifadhi PDF", addToWallet: "Weka kwenye wallet",
    sendTicket: "Tuma kwa simu", retrieve: "Pata booking yangu", locator: "Namba ya booking",
    surname: "Jina la ukoo", cancelBooking: "Ghairi na urudishiwe", refundDue: "Marejesho",
    conditions: "Masharti ya usafiri", outbound: "Kwenda", inbound: "Kurudi",
    promoCode: "Namba ya punguzo", apply: "Tumia", fiscalReceipt: "Risiti ya VAT",
    departsIn: "Inaondoka baada ya", noResults: "Hakuna safari inayolingana",
    noResultsBody: "Punguza kichujio, au jaribu tarehe nyingine.", searching: "Inatafuta safari",
    offline: "Hauna mtandao. Tiketi yako inafanya kazi — msimbo unasomeka bila mtandao.",
    savedTravellers: "Wasafiri waliohifadhiwa", saveTraveller: "Hifadhi kwa safari zijazo",
    passengerMode: "Abiria", gateMode: "Lango",
  },
};

/* ═══ machine ═════════════════════════════════════════════════════════════ */

const HOLD_DURATION_MS = 10 * 60 * 1000;
const STEP_INDEX = { search: 0, results: 1, seats: 2, checkout: 3, ticket: 4, manage: 0 };

const initialState = {
  step: "search",
  criteria: { from: "DAR", to: "ARK", date: todayISO(), returnDate: addDaysISO(todayISO(), 3), roundTrip: false, paxCount: 1 },
  loading: false, results: [], filters: EMPTY_FILTERS,
  segments: [], legCursor: 0, holdToken: null, holdExpiresAt: null, holdExpired: false,
  passengers: [], openTraveller: 0,
  ancillaries: { extraBag: 0, insurance: false, flexible: false },
  promo: { input: "", applied: null, error: null },
  contact: { dial: "+255", phone: "", email: "" },
  payment: { method: "mpesa", status: "idle", error: null, attempt: 0, idempotencyKey: null, simulateDecline: false },
  booking: null,
};

const legCount = (c) => (c.roundTrip ? 2 : 1);

function reducer(state, action) {
  switch (action.type) {
    case "SET_CRITERIA": {
      const criteria = { ...state.criteria, ...action.patch };
      if (criteria.returnDate < criteria.date) criteria.returnDate = addDaysISO(criteria.date, 1);
      return { ...state, criteria };
    }
    case "SEARCH_START": return { ...state, step: "results", loading: true, results: [], filters: EMPTY_FILTERS, segments: [], legCursor: 0, holdExpiresAt: null, holdExpired: false };
    case "SEARCH_DONE": return { ...state, loading: false, results: action.services };
    case "SET_FILTERS": return { ...state, filters: action.filters };
    case "SELECT_SERVICE": {
      const segments = [...state.segments.slice(0, state.legCursor), { dir: state.legCursor === 0 ? "OUT" : "RET", service: action.service, seats: [] }];
      const more = segments.length < legCount(state.criteria);
      return {
        ...state, segments, legCursor: more ? state.legCursor + 1 : 0,
        results: more ? action.nextResults || [] : state.results,
        filters: more ? EMPTY_FILTERS : state.filters, step: more ? "results" : "seats",
      };
    }
    case "SET_LEG_CURSOR": return { ...state, legCursor: action.index };
    case "SET_SEATS": {
      const segments = state.segments.map((s, i) => (i === state.legCursor ? { ...s, seats: action.seats } : s));
      return {
        ...state, segments, holdExpired: false,
        // The server owns the hold; these mirror what it granted.
        holdToken: action.holdToken ?? state.holdToken,
        holdExpiresAt: action.expiresAt ?? state.holdExpiresAt,
      };
    }
    case "TOGGLE_SEAT": {
      const seg = state.segments[state.legCursor];
      if (!seg || seg.service.soldSeats.has(action.seat)) return state;
      const held = seg.seats.includes(action.seat);
      let seats;
      if (held) seats = seg.seats.filter((s) => s !== action.seat);
      else if (seg.seats.length >= state.criteria.paxCount) return state;
      else seats = [...seg.seats, action.seat].sort((a, b) => a - b);
      return reducer(state, { type: "SET_SEATS", seats });
    }
    case "SEATS_NEXT": {
      if (state.legCursor < state.segments.length - 1) return { ...state, legCursor: state.legCursor + 1 };
      return {
        ...state, step: "checkout", openTraveller: 0,
        passengers: Array.from({ length: state.criteria.paxCount }, (_, i) => state.passengers[i] ||
          { firstName: "", lastName: "", type: "ADT", documentType: "NID", documentNumber: "", nationality: "TZ" }),
      };
    }
    case "HOLD_EXPIRED":
      return {
        ...state, step: "seats", legCursor: 0, holdToken: null, holdExpiresAt: null, holdExpired: true,
        segments: state.segments.map((s) => ({ ...s, seats: [] })),
        payment: { ...state.payment, status: "idle", error: null, attempt: 0, idempotencyKey: null },
      };
    case "PATCH_PASSENGER": return { ...state, passengers: state.passengers.map((p, i) => (i === action.index ? { ...p, ...action.patch } : p)) };
    case "OPEN_TRAVELLER": return { ...state, openTraveller: action.index };
    case "PATCH_CONTACT": return { ...state, contact: { ...state.contact, ...action.patch } };
    case "PATCH_ANCILLARY": return { ...state, ancillaries: { ...state.ancillaries, ...action.patch } };
    case "PATCH_PROMO": return { ...state, promo: { ...state.promo, ...action.patch } };
    case "PATCH_PAYMENT": return { ...state, payment: { ...state.payment, ...action.patch } };
    case "PAYMENT_START": return { ...state, payment: { ...state.payment, status: "processing", error: null, attempt: state.payment.attempt + 1, idempotencyKey: action.key } };
    case "PAYMENT_PENDING": return { ...state, payment: { ...state.payment, status: "pending" } };
    case "PAYMENT_FAILED": return { ...state, payment: { ...state.payment, status: "failed", error: action.error } };
    case "BOOKING_ISSUED": return { ...state, step: "ticket", booking: action.booking, holdExpiresAt: null, payment: { ...state.payment, status: "captured" } };
    case "OPEN_BOOKING": return { ...state, step: "ticket", booking: action.booking };
    case "BOOKING_CANCELLED": return { ...state, booking: { ...state.booking, status: "REFUNDED", refund: action.refund } };
    case "GO": return { ...state, step: action.step };
    case "RESET": return { ...initialState, criteria: { ...initialState.criteria, date: todayISO(), returnDate: addDaysISO(todayISO(), 3) } };
    default: return state;
  }
}

/* ═══ ui/tokens ═══════════════════════════════════════════════════════════ */

const Styles = () => (
  <style>{`
    @import url('https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700;800&family=Archivo+Expanded:wght@700;800&family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600;700&display=swap');

    .sy{--ink:#10161C;--ink-70:#4A5560;--ink-45:#79838D;--surface:#FFFFFF;--field:#F1F4F7;
      --line:#DFE5EB;--line-2:#C4CDD6;--cobalt:#1B4FD8;--cobalt-deep:#12308A;--cobalt-tint:#EDF2FE;
      --amber:#F5A524;--amber-tint:#FEF6E7;--verdant:#0E7A5F;--verdant-tint:#E9F5F1;
      --rose:#C42A3A;--rose-tint:#FDEEF0;--carbon:#FBF7E9;
      --raise:0 1px 2px rgba(16,22,28,.04),0 8px 24px -12px rgba(16,22,28,.18);
      font-family:'IBM Plex Sans',system-ui,sans-serif;background:var(--field);color:var(--ink);
      min-height:100vh;-webkit-font-smoothing:antialiased}

    .sy .t-dxl{font-family:'Archivo Expanded','Archivo',sans-serif;font-weight:800;font-size:40px;line-height:1.02;letter-spacing:-.01em}
    .sy .t-dl{font-family:'Archivo',sans-serif;font-weight:800;font-size:28px;line-height:1.08;letter-spacing:-.015em}
    .sy .t-dm{font-family:'Archivo',sans-serif;font-weight:700;font-size:20px;line-height:1.2;letter-spacing:-.01em}
    .sy .t-ti{font-family:'Archivo',sans-serif;font-weight:700;font-size:16px;line-height:1.3}
    .sy .t-bl{font-size:15px;line-height:1.5} .sy .t-bd{font-size:14px;line-height:1.5}
    .sy .t-bs{font-size:13px;line-height:1.45} .sy .t-cp{font-size:12px;line-height:1.35}
    .sy .t-mi{font-size:11px;line-height:1.3;text-transform:uppercase;letter-spacing:.08em;font-weight:600}
    .sy .t-dtl{font-family:'IBM Plex Mono',monospace;font-weight:600;font-size:18px;font-variant-numeric:tabular-nums}
    .sy .mono{font-family:'IBM Plex Mono',monospace;font-variant-numeric:tabular-nums}
    .sy .muted{color:var(--ink-70)} .sy .faint{color:var(--ink-45)}
    .sy *:focus-visible{outline:3px solid var(--cobalt);outline-offset:2px;border-radius:4px}

    .sy-skip{position:absolute;left:-9999px;top:8px;z-index:80;background:var(--ink);color:#fff;padding:12px 16px;border-radius:6px;font-size:13px;font-weight:600}
    .sy-skip:focus{left:12px}

    .sy-card{background:var(--surface);border:1px solid var(--line);border-radius:10px}
    .sy-card-raise{background:var(--surface);border:1px solid var(--line);border-radius:10px;box-shadow:var(--raise)}

    .sy-btn{border-radius:6px;font-weight:600;font-size:14px;min-height:44px;padding:0 20px;
      display:inline-flex;align-items:center;justify-content:center;gap:8px;cursor:pointer;
      border:1.5px solid transparent;transition:background .15s,border-color .15s,color .15s;font-family:inherit}
    .sy-btn:active:not(:disabled){transform:translateY(1px)}
    .sy-btn-primary{background:var(--cobalt);color:#fff}
    .sy-btn-primary:hover:not(:disabled){background:var(--cobalt-deep)}
    .sy-btn-primary:disabled{background:#AEB8C4;cursor:not-allowed}
    .sy-btn-secondary{background:var(--surface);border-color:var(--line-2);color:var(--ink)}
    .sy-btn-secondary:hover{border-color:var(--ink);background:var(--field)}
    .sy-btn-quiet{background:transparent;color:var(--ink-70);padding:0 8px}
    .sy-btn-quiet:hover{color:var(--ink)}
    .sy-btn-danger{background:var(--surface);border-color:var(--rose);color:var(--rose)}
    .sy-btn-danger:hover{background:var(--rose);color:#fff}
    .sy-btn-sm{min-height:36px;font-size:13px;padding:0 12px}

    .sy-input{width:100%;background:var(--surface);border:1.5px solid var(--line-2);border-radius:6px;
      min-height:44px;padding:10px 12px;font-size:15px;color:var(--ink);outline:none;font-family:inherit}
    .sy-input:focus{border-color:var(--cobalt);box-shadow:0 0 0 3px var(--cobalt-tint)}
    .sy-input[aria-invalid="true"]{border-color:var(--rose);background:var(--rose-tint)}
    .sy-label{font-size:11px;line-height:1.3;text-transform:uppercase;letter-spacing:.08em;font-weight:600;
      color:var(--ink-70);display:flex;align-items:center;gap:4px;margin-bottom:6px}
    .sy-err{font-size:12px;color:var(--rose);margin-top:6px;display:flex;align-items:flex-start;gap:4px}

    .sy-chip{border-radius:999px;padding:8px 14px;font-size:13px;font-weight:600;min-height:40px;
      border:1.5px solid var(--line-2);background:var(--surface);cursor:pointer;
      display:inline-flex;align-items:center;gap:6px;font-family:inherit;color:var(--ink)}
    .sy-chip:hover{border-color:var(--ink)}
    .sy-chip[aria-pressed="true"]{background:var(--ink);border-color:var(--ink);color:#fff}
    .sy-chip-seg{border-radius:6px}

    .sy-stripe{display:flex;height:6px;background:var(--line);overflow:hidden}
    .sy-stripe span{flex:1;background:var(--line);transition:background .18s ease}
    .sy-stripe span[data-on="done"]{background:var(--cobalt)}
    .sy-stripe span[data-on="now"]{background:var(--amber)}

    .sy-plate{background:var(--cobalt-deep);color:#fff;position:relative;
      background-image:linear-gradient(180deg,rgba(255,255,255,.08),rgba(0,0,0,.12))}
    .sy-plate::after{content:'';position:absolute;left:0;right:0;bottom:0;height:4px;
      background:linear-gradient(90deg,var(--amber) 0 33%,#FFF6E3 33% 66%,var(--cobalt) 66% 100%)}
    .sy-plate-code{font-family:'Archivo Expanded','Archivo',sans-serif;font-weight:800;letter-spacing:.06em}

    .sy-seat{width:44px;height:44px;border-radius:6px 6px 3px 3px;display:flex;align-items:center;
      justify-content:center;font-size:13px;font-weight:600;border:1.5px solid var(--line-2);
      background:var(--surface);cursor:pointer;font-family:'IBM Plex Mono',monospace;position:relative;
      color:var(--ink);transition:border-color .12s,background .12s}
    .sy-seat[data-state="sold"]{background:var(--field);border-color:var(--line);color:var(--ink-45);cursor:not-allowed}
    .sy-seat[data-state="sold"]::before{content:'';position:absolute;inset:8px;
      background:linear-gradient(135deg,transparent 45%,var(--line-2) 45% 55%,transparent 55%)}
    .sy-seat[data-state="free"]:hover{border-color:var(--cobalt);background:var(--cobalt-tint)}
    .sy-seat[data-state="selected"]{background:var(--cobalt);border-color:var(--cobalt);color:#fff}
    .sy-seat[data-state="boarded"]{background:var(--verdant);border-color:var(--verdant);color:#fff}
    .sy-seat[data-premium="true"]::after{content:'';position:absolute;top:3px;right:3px;width:5px;height:5px;border-radius:50%;background:var(--amber)}
    .sy-seat[data-accessible="true"]{border-style:dashed;border-width:2px}

    .sy-perf{position:relative;border-top:2px dashed var(--line-2)}
    .sy-perf::before,.sy-perf::after{content:'';position:absolute;top:-13px;width:24px;height:24px;background:var(--field);border-radius:50%}
    .sy-perf::before{left:-13px}.sy-perf::after{right:-13px}
    .sy-stamp{border:2.5px solid currentColor;border-radius:6px;padding:4px 10px;font-family:'Archivo',sans-serif;
      font-weight:800;font-size:12px;letter-spacing:.12em;text-transform:uppercase;transform:rotate(-4deg);opacity:.85}
    .sy-carbon{background:var(--carbon)}
    .sy-rule{flex:1;height:1px;background:var(--line-2)}
    .sy-dot{width:7px;height:7px;border-radius:50%;background:currentColor;flex-shrink:0}

    .sy-bar{position:fixed;left:0;right:0;bottom:0;z-index:50;background:var(--surface);
      border-top:1px solid var(--line);box-shadow:0 -8px 24px -16px rgba(16,22,28,.3);padding-bottom:env(safe-area-inset-bottom)}
    .sy-has-bar{padding-bottom:104px}
    @media (min-width:1024px){.sy-bar{display:none}.sy-has-bar{padding-bottom:0}}

    /* gate console: high-contrast verdict, readable at arm's length in daylight */
    .sy-verdict{border-radius:10px;padding:24px;text-align:center;color:#fff}
    .sy-verdict[data-tone="pass"]{background:var(--verdant)}
    .sy-verdict[data-tone="fail"]{background:var(--rose)}
    .sy-verdict[data-tone="warn"]{background:#B5750B}
    .sy-verdict-label{font-family:'Archivo Expanded','Archivo',sans-serif;font-weight:800;font-size:34px;line-height:1;letter-spacing:.02em}

    .sy-enter{animation:sy-in .18s ease-out both}
    @keyframes sy-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
    .sy-skel{background:linear-gradient(90deg,var(--line) 25%,#E9EEF3 37%,var(--line) 63%);background-size:400% 100%;animation:sy-shimmer 1.4s linear infinite;border-radius:6px}
    @keyframes sy-shimmer{from{background-position:100% 0}to{background-position:0 0}}
    @media (prefers-reduced-motion:reduce){.sy-enter,.sy-skel,.sy-stripe span{animation:none;transition:none}}

    ::selection{background:var(--amber);color:var(--ink)}

    @media print{
      @page{size:A4;margin:14mm}
      .sy{background:#fff}
      .sy-noprint,.sy-bar{display:none !important}
      .sy-doc{break-inside:avoid;border:1px solid #000 !important;border-radius:0 !important;box-shadow:none !important}
      .sy-plate{background:#fff !important;color:#000 !important;border-bottom:2px solid #000}
      .sy-plate *{color:#000 !important}
      .sy-plate::after,.sy-perf::before,.sy-perf::after{display:none}
      .sy-carbon{background:#fff !important}
      .muted,.faint{color:#333 !important}
    }
  `}</style>
);

/* ═══ ui/primitives ═══════════════════════════════════════════════════════ */

function Field({ label, hint, error, children, icon: Icon, id }) {
  return (
    <div>
      <label className="sy-label" htmlFor={id}>{Icon && <Icon size={11} aria-hidden />}{label}</label>
      {children}
      {error ? <p className="sy-err" role="alert"><AlertCircle size={12} className="shrink-0 mt-px" aria-hidden />{error}</p>
        : hint ? <p className="t-cp faint mt-1">{hint}</p> : null}
    </div>
  );
}

const AMENITY_ICON = { ac: Wind, charge: BatteryCharging, wifi: Wifi, tv: Tv };
const AMENITY_LABEL = { ac: "Air conditioning", charge: "Charging point", wifi: "Wi-Fi", tv: "Entertainment" };

function Amenities({ cabin }) {
  return (
    <span className="flex items-center gap-1">
      {cabin.amenities.map((a) => {
        const Icon = AMENITY_ICON[a];
        return (
          <span key={a} title={AMENITY_LABEL[a]} className="w-7 h-7 rounded flex items-center justify-center" style={{ background: "var(--field)" }}>
            <Icon size={13} aria-hidden />
          </span>
        );
      })}
    </span>
  );
}

function CabinBadge({ cabinKey }) {
  const c = CABINS[cabinKey];
  return <span className="t-mi px-2 py-1 rounded" style={{ background: `${c.accent}14`, color: c.accent }}>{c.label}</span>;
}

function Skeleton({ h = 16, w = "100%" }) {
  return <div className="sy-skel" style={{ height: h, width: w }} aria-hidden />;
}

function QRCode({ payload, size = 132, label }) {
  const qr = useMemo(() => { try { return encodeQR(payload); } catch { return null; } }, [payload]);
  if (!qr) return null;
  const n = qr.matrix.length, quiet = 4, total = n + quiet * 2, rects = [];
  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      if (qr.matrix[r][c]) {
        let w = 1;
        while (c + w < n && qr.matrix[r][c + w]) w++;
        rects.push(<rect key={`${r}-${c}`} x={c + quiet} y={r + quiet} width={w} height={1} />);
        c += w;
      } else c++;
    }
  }
  return (
    <svg viewBox={`0 0 ${total} ${total}`} width={size} height={size} shapeRendering="crispEdges" role="img" aria-label={label || "Boarding QR code"}>
      <rect width={total} height={total} fill="#fff" />
      <g fill="#10161C">{rects}</g>
    </svg>
  );
}

function ProgressStripe({ current, t }) {
  const labels = t("steps");
  return (
    <div className="sy-noprint">
      <div className="sy-stripe" role="progressbar" aria-valuemin={1} aria-valuemax={labels.length}
        aria-valuenow={current + 1} aria-valuetext={`Step ${current + 1} of ${labels.length}: ${labels[current]}`}>
        {labels.map((_, i) => <span key={i} data-on={i < current ? "done" : i === current ? "now" : "todo"} />)}
      </div>
      <div className="max-w-6xl mx-auto px-4 py-2 hidden sm:flex items-center gap-2">
        {labels.map((label, i) => (
          <React.Fragment key={label}>
            <span className="t-cp flex items-center gap-1.5" style={{ color: i === current ? "var(--ink)" : "var(--ink-45)", fontWeight: i === current ? 600 : 400 }}>
              {i < current && <Check size={12} style={{ color: "var(--cobalt)" }} aria-hidden />}{label}
            </span>
            {i < labels.length - 1 && <span className="sy-rule" style={{ maxWidth: 24 }} aria-hidden />}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

function RoutePlate({ criteria, segments, lang, compact, onEdit, t }) {
  const outbound = segments[0]?.service;
  const from = stationBy(outbound?.from ?? criteria.from), to = stationBy(outbound?.to ?? criteria.to);
  return (
    <div className="sy-plate sy-noprint">
      <div className={`max-w-6xl mx-auto px-4 ${compact ? "py-3" : "py-5"} flex items-center justify-between gap-4`}>
        <div className="flex items-center gap-3 min-w-0">
          <span className="min-w-0">
            <span className={`sy-plate-code block ${compact ? "text-lg" : "text-2xl"}`}>{from.code}</span>
            {!compact && <span className="t-cp block" style={{ color: "#BCCBF0" }}>{from.name}</span>}
          </span>
          <span className="flex items-center gap-1 shrink-0" style={{ color: "var(--amber)", width: 40 }} aria-hidden>
            <span className="sy-dot" /><span className="sy-rule" style={{ background: "currentColor", opacity: .5 }} />
            {criteria.roundTrip ? <Repeat size={13} /> : <ArrowRight size={13} />}
          </span>
          <span className="min-w-0">
            <span className={`sy-plate-code block ${compact ? "text-lg" : "text-2xl"}`}>{to.code}</span>
            {!compact && <span className="t-cp block" style={{ color: "#BCCBF0" }}>{to.name}</span>}
          </span>
        </div>
        <div className="flex items-center gap-4 shrink-0">
          <span className="text-right hidden sm:block">
            <span className="mono t-bs block" style={{ color: "#fff" }}>{formatDate(criteria.date, lang)}</span>
            <span className="t-cp block" style={{ color: "#BCCBF0" }}>
              {criteria.roundTrip && `${formatDate(criteria.returnDate, lang)} · `}{criteria.paxCount} pax
            </span>
          </span>
          {onEdit && (
            <button onClick={onEdit} className="sy-btn sy-btn-sm" style={{ background: "rgba(255,255,255,.14)", color: "#fff", borderColor: "rgba(255,255,255,.3)" }}>
              {t("editSearch")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function FareSummary({ quote, currency, t, variant, cta, onCta, ctaDisabled, secondary, children }) {
  const [open, setOpen] = useState(false);
  if (variant === "bar") {
    return (
      <div className="sy-bar sy-noprint">
        {open && (
          <div className="max-w-6xl mx-auto px-4 pt-4 border-b" style={{ borderColor: "var(--line)", maxHeight: "40vh", overflowY: "auto" }}>
            <dl className="t-bs space-y-2 pb-4">
              {quote.breakdown.map((b) => (
                <div key={b.code} className="flex justify-between gap-3">
                  <dt className="muted">{b.label}</dt>
                  <dd className="mono" style={b.amount < 0 ? { color: "var(--verdant)" } : undefined}>{Money.format(b.amount, currency)}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-3">
          <button onClick={() => setOpen(!open)} className="text-left shrink-0" aria-expanded={open}>
            <span className="t-cp muted flex items-center gap-1">{t("total")} <ChevronDown size={12} aria-hidden style={{ transform: open ? "rotate(180deg)" : "none" }} /></span>
            <span className="t-dtl block">{Money.format(quote.total, currency)}</span>
          </button>
          <button className="sy-btn sy-btn-primary flex-1" disabled={ctaDisabled} onClick={onCta}>{cta} <ChevronRight size={16} aria-hidden /></button>
        </div>
      </div>
    );
  }
  return (
    <aside className="hidden lg:block sy-card p-5 sticky top-4" aria-label="Fare summary">
      <h2 className="t-ti mb-4">{t("total")}</h2>
      {children}
      <dl className="t-bs space-y-2">
        {quote.breakdown.map((b) => (
          <div key={b.code} className="flex justify-between gap-3">
            <dt className="muted">{b.label} <span className="mono t-cp faint">[{b.code}]</span></dt>
            <dd className="mono" style={b.amount < 0 ? { color: "var(--verdant)" } : undefined}>{Money.format(b.amount, currency)}</dd>
          </div>
        ))}
      </dl>
      <div className="flex items-baseline justify-between mt-4 pt-4 border-t" style={{ borderColor: "var(--line)" }}>
        <span className="t-ti">{t("total")}</span>
        <span className="t-dtl" style={{ color: "var(--cobalt)" }}>{Money.format(quote.total, currency)}</span>
      </div>
      <button className="sy-btn sy-btn-primary w-full mt-4" disabled={ctaDisabled} onClick={onCta}>{cta} <ChevronRight size={16} aria-hidden /></button>
      {secondary}
    </aside>
  );
}

function HoldTimer({ expiresAt, onExpire, t }) {
  const [left, setLeft] = useState(() => Math.max(0, expiresAt - Date.now()));
  const fired = useRef(false);
  useEffect(() => {
    fired.current = false;
    const tick = () => {
      const rem = Math.max(0, expiresAt - Date.now());
      setLeft(rem);
      if (rem === 0 && !fired.current) { fired.current = true; onExpire(); }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [expiresAt, onExpire]);
  const mm = String(Math.floor(left / 60000)).padStart(2, "0");
  const ss = String(Math.floor((left % 60000) / 1000)).padStart(2, "0");
  const urgent = left < 120000;
  return (
    <span className="sy-noprint inline-flex items-center gap-2 px-3 py-2 rounded t-cp font-semibold" role="timer"
      style={{ background: urgent ? "var(--rose-tint)" : "var(--amber-tint)", color: urgent ? "var(--rose)" : "#8A5A0B" }}>
      <Timer size={13} aria-hidden /> {t("holdExpires")} <span className="mono">{mm}:{ss}</span>
    </span>
  );
}

function Announcer({ message }) {
  return <div aria-live="polite" aria-atomic="true" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>{message}</div>;
}

class ErrorBoundary extends React.Component {
  constructor(p) { super(p); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="max-w-md mx-auto px-4 py-14 text-center">
        <AlertCircle size={28} style={{ color: "var(--rose)" }} className="mx-auto mb-4" aria-hidden />
        <h1 className="t-dm mb-2">This page stopped working</h1>
        <p className="t-bd muted mb-5">No payment was taken. Any reference already issued is safe — find it under Find a booking.</p>
        <button className="sy-btn sy-btn-primary" onClick={() => this.setState({ error: null })}>Try again</button>
      </div>
    );
  }
}

/* ═══ ui/header ═══════════════════════════════════════════════════════════ */

function Header({ lang, setLang, currency, setCurrency, onHome, onManage, t }) {
  return (
    <header className="sy-noprint" style={{ background: "var(--surface)", borderBottom: "1px solid var(--line)" }}>
      <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
        <button onClick={onHome} className="flex items-center gap-2.5 text-left">
          <span className="w-9 h-9 rounded flex items-center justify-center" style={{ background: "var(--cobalt)" }}>
            <Bus size={18} color="#fff" aria-hidden />
          </span>
          <span>
            <span className="t-ti block leading-none">Safari<span style={{ color: "var(--cobalt)" }}>Tiketi</span></span>
            <span className="t-mi block faint mt-1">{t("tagline")}</span>
          </span>
        </button>

        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={onManage} className="sy-btn sy-btn-secondary sy-btn-sm hidden sm:inline-flex">
            <Ticket size={14} aria-hidden /> {t("manage")}
          </button>
          <select value={currency} onChange={(e) => setCurrency(e.target.value)} className="sy-input mono t-bs"
            style={{ width: "auto", minHeight: 36, padding: "0 8px" }} aria-label="Display currency">
            {Object.keys(FX).map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <button onClick={() => setLang(lang === "en" ? "sw" : "en")} className="sy-btn sy-btn-secondary sy-btn-sm"
            aria-label={lang === "en" ? "Badili lugha kwa Kiswahili" : "Switch to English"}>
            <Globe size={14} aria-hidden /> {lang === "en" ? "SW" : "EN"}
          </button>
        </div>
      </div>
    </header>
  );
}

/* ═══ ui/passenger steps ══════════════════════════════════════════════════ */

function SearchStep({ criteria, dispatch, onSearch, t, recent, onOpenBooking, headingRef }) {
  const same = criteria.from === criteria.to;
  const distance = same ? 0 : roadDistanceKm(stationBy(criteria.from), stationBy(criteria.to));
  return (
    <div className="sy-enter">
      <div className="max-w-6xl mx-auto px-4 pt-8 pb-6">
        <p className="t-mi faint mb-3">{t("heroKicker")}</p>
        <h1 className="t-dxl" tabIndex={-1} ref={headingRef} style={{ maxWidth: 520 }}>{t("heroLead")}</h1>
      </div>
      <div className="max-w-6xl mx-auto px-4">
        <div className="sy-card-raise p-4 sm:p-6">
          <div className="flex gap-2 mb-5" role="group" aria-label="Journey type">
            {[[false, t("oneWay")], [true, t("roundTrip")]].map(([val, label]) => (
              <button key={String(val)} className="sy-chip sy-chip-seg" aria-pressed={criteria.roundTrip === val}
                onClick={() => dispatch({ type: "SET_CRITERIA", patch: { roundTrip: val } })}>{label}</button>
            ))}
          </div>
          <div className="grid sm:grid-cols-[1fr_auto_1fr] gap-4 items-end">
            <Field label={t("from")} icon={MapPin} id="f-from">
              <select id="f-from" className="sy-input" value={criteria.from} aria-invalid={same}
                onChange={(e) => dispatch({ type: "SET_CRITERIA", patch: { from: e.target.value } })}>
                {STATIONS.map((s) => <option key={s.code} value={s.code}>{s.name} · {s.code}</option>)}
              </select>
            </Field>
            <button className="hidden sm:flex items-center justify-center rounded-full shrink-0"
              style={{ width: 44, height: 44, background: "var(--field)", border: "1.5px solid var(--line-2)" }}
              aria-label="Swap origin and destination"
              onClick={() => dispatch({ type: "SET_CRITERIA", patch: { from: criteria.to, to: criteria.from } })}>
              <ArrowLeftRight size={16} aria-hidden />
            </button>
            <Field label={t("to")} icon={MapPin} id="f-to">
              <select id="f-to" className="sy-input" value={criteria.to} aria-invalid={same}
                onChange={(e) => dispatch({ type: "SET_CRITERIA", patch: { to: e.target.value } })}>
                {STATIONS.map((s) => <option key={s.code} value={s.code}>{s.name} · {s.code}</option>)}
              </select>
            </Field>
          </div>
          <div className={`grid gap-4 items-end mt-4 ${criteria.roundTrip ? "sm:grid-cols-[1fr_1fr_130px]" : "sm:grid-cols-[1fr_130px]"}`}>
            <Field label={t("date")} icon={Clock} id="f-date">
              <input id="f-date" type="date" className="sy-input mono" min={todayISO()} value={criteria.date}
                onChange={(e) => dispatch({ type: "SET_CRITERIA", patch: { date: e.target.value } })} />
            </Field>
            {criteria.roundTrip && (
              <Field label={t("returnDate")} icon={Repeat} id="f-ret">
                <input id="f-ret" type="date" className="sy-input mono" min={criteria.date} value={criteria.returnDate}
                  onChange={(e) => dispatch({ type: "SET_CRITERIA", patch: { returnDate: e.target.value } })} />
              </Field>
            )}
            <Field label={t("passengers")} icon={Users} id="f-pax">
              <select id="f-pax" className="sy-input" value={criteria.paxCount}
                onChange={(e) => dispatch({ type: "SET_CRITERIA", patch: { paxCount: Number(e.target.value) } })}>
                {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </Field>
          </div>
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mt-5">
            <p className="t-cp muted mono" role="status">
              {same ? <span style={{ color: "var(--rose)" }}>Origin and destination must differ.</span>
                : <>≈{distance} {t("km")} by road{criteria.roundTrip && ` · inbound leg ${RETURN_DISCOUNT_PCT}% off`}</>}
            </p>
            <button className="sy-btn sy-btn-primary w-full sm:w-auto" disabled={same} onClick={onSearch}>
              <Search size={16} aria-hidden /> {t("searchBuses")}
            </button>
          </div>
        </div>
      </div>

      {recent.length > 0 && (
        <section className="max-w-6xl mx-auto px-4 mt-10">
          <h2 className="t-ti mb-3">Recent bookings</h2>
          <div className="grid sm:grid-cols-2 gap-3">
            {recent.slice(0, 4).map((b) => (
              <button key={b.locator} onClick={() => onOpenBooking(b)} className="sy-card p-4 text-left flex items-center justify-between gap-3">
                <span className="min-w-0">
                  <span className="mono t-bs font-semibold block" style={{ letterSpacing: ".1em" }}>{b.locator}</span>
                  <span className="t-cp muted block truncate">
                    {b.segments.map((s) => `${s.service.from}→${s.service.to}`).join(" · ")} · {b.segments[0].service.departISO.slice(0, 10)}
                  </span>
                </span>
                <ChevronRight size={15} className="shrink-0" aria-hidden />
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="max-w-6xl mx-auto px-4 my-12 grid sm:grid-cols-3 gap-4">
        {[
          { icon: Fingerprint, h: "Signed, not just printed", p: "Every ticket carries an HMAC signature. The gate verifies it offline, so a forged code fails at the door." },
          { icon: Receipt, h: "A receipt you can file", p: "TRA-format VAT receipt with a verification code, issued with every booking." },
          { icon: AlertTriangle, h: "Disruption handled, not discussed", p: "If your coach is delayed or cancelled, compensation is computed from a published table and rebooking comes to you." },
        ].map((c) => (
          <div key={c.h} className="sy-card p-5">
            <c.icon size={20} style={{ color: "var(--cobalt)" }} aria-hidden />
            <h3 className="t-ti mt-3 mb-1">{c.h}</h3>
            <p className="t-bs muted">{c.p}</p>
          </div>
        ))}
      </section>
    </div>
  );
}

function FilterPanel({ services, filters, onChange, t }) {
  const carriers = useMemo(() => [...new Map(services.map((s) => [s.carrier.code, s.carrier])).values()], [services]);
  const cabins = useMemo(() => [...new Set(services.map((s) => s.cabinKey))], [services]);
  const toggle = (key, val) => onChange({ ...filters, [key]: filters[key].includes(val) ? filters[key].filter((v) => v !== val) : [...filters[key], val] });
  const group = (title, items, key, labelFor) => (
    <div>
      <h3 className="sy-label">{title}</h3>
      <div className="flex flex-wrap gap-2">
        {items.map((item) => {
          const val = typeof item === "string" ? item : item.id ?? item.code;
          return (
            <button key={val} className="sy-chip" aria-pressed={filters[key].includes(val)} onClick={() => toggle(key, val)}>
              {filters[key].includes(val) && <Check size={13} aria-hidden />}{labelFor(item)}
            </button>
          );
        })}
      </div>
    </div>
  );
  return (
    <div className="space-y-5">
      {group(t("sortDepart"), DEPARTURE_WINDOWS, "windows", (w) => w.label)}
      {group("Class", cabins, "cabins", (c) => CABINS[c].label)}
      {group("Operator", carriers, "carriers", (c) => c.name)}
      {group("Onboard", ["wifi", "tv", "charge"], "amenities", (a) => AMENITY_LABEL[a])}
    </div>
  );
}

function ResultsStep({ state, dispatch, t, lang, currency, onSelect, headingRef }) {
  const [sort, setSort] = useState("depart");
  const [showFilters, setShowFilters] = useState(false);
  const { criteria, results, filters, legCursor, loading } = state;
  const isReturn = legCursor === 1;

  const filtered = useMemo(() => applyFilters(results, filters), [results, filters]);
  const sorted = useMemo(() => {
    const arr = [...filtered];
    if (sort === "price") arr.sort((a, b) => baseFareFor(a) - baseFareFor(b));
    else if (sort === "duration") arr.sort((a, b) => a.durationMin - b.durationMin);
    else arr.sort((a, b) => a.departISO.localeCompare(b.departISO));
    return arr;
  }, [filtered, sort]);

  const badgeFor = useMemo(() => {
    if (filtered.length < 2) return () => [];
    const cheapest = filtered.reduce((a, b) => (baseFareFor(b) < baseFareFor(a) ? b : a));
    const fastest = filtered.reduce((a, b) => (b.durationMin < a.durationMin ? b : a));
    return (s) => [
      ...(s.id === cheapest.id ? [{ id: "c", label: t("cheapest"), icon: TrendingDown, tint: "var(--verdant-tint)", color: "var(--verdant)" }] : []),
      ...(s.id === fastest.id && fastest.id !== cheapest.id ? [{ id: "f", label: t("fastest"), icon: Zap, tint: "var(--cobalt-tint)", color: "var(--cobalt)" }] : []),
    ];
  }, [filtered, t]);

  const nActive = filterCount(filters);

  return (
    <div className="max-w-6xl mx-auto px-4 py-6 sy-enter">
      {criteria.roundTrip && (
        <ol className="flex items-center gap-2 mb-4 t-cp" aria-label="Journey legs">
          {[t("outbound"), t("inbound")].map((label, i) => (
            <li key={label} className="flex items-center gap-2">
              <span className="px-3 py-1.5 rounded-full font-semibold" style={{
                background: i === legCursor ? "var(--ink)" : "var(--surface)",
                color: i === legCursor ? "#fff" : "var(--ink-45)",
                border: "1px solid " + (i === legCursor ? "var(--ink)" : "var(--line)"),
              }}>{i + 1}. {label}</span>
              {i === 0 && <ChevronRight size={13} className="faint" aria-hidden />}
            </li>
          ))}
        </ol>
      )}

      <h1 className="t-dl mb-1" tabIndex={-1} ref={headingRef}>{loading ? t("searching") : `${sorted.length} ${t("servicesFound")}`}</h1>
      <p className="t-bs muted mb-5">
        {stationBy(isReturn ? criteria.to : criteria.from).name} to {stationBy(isReturn ? criteria.from : criteria.to).name} · {formatDate(isReturn ? criteria.returnDate : criteria.date, lang)}
      </p>

      <div className="grid lg:grid-cols-[240px_1fr] gap-6 items-start">
        <div>
          <button className="sy-btn sy-btn-secondary w-full lg:hidden mb-3" onClick={() => setShowFilters(!showFilters)} aria-expanded={showFilters}>
            <SlidersHorizontal size={15} aria-hidden /> {t("filters")}{nActive > 0 && ` (${nActive})`}
          </button>
          <div className={`sy-card p-5 ${showFilters ? "" : "hidden"} lg:block lg:sticky lg:top-4`}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="t-ti">{t("filters")}</h2>
              {nActive > 0 && <button className="sy-btn sy-btn-quiet t-cp" style={{ minHeight: 32 }} onClick={() => dispatch({ type: "SET_FILTERS", filters: EMPTY_FILTERS })}>{t("clearFilters")}</button>}
            </div>
            <FilterPanel services={results} filters={filters} onChange={(f) => dispatch({ type: "SET_FILTERS", filters: f })} t={t} />
          </div>
        </div>

        <div>
          <div className="flex gap-2 mb-4 overflow-x-auto pb-1" role="group" aria-label="Sort services">
            {[["depart", t("sortDepart")], ["price", t("sortPrice")], ["duration", t("sortDuration")]].map(([k, label]) => (
              <button key={k} className="sy-chip shrink-0" aria-pressed={sort === k} onClick={() => setSort(k)}>{label}</button>
            ))}
          </div>

          {loading ? (
            <ul className="space-y-3" aria-busy="true">
              {[0, 1, 2].map((i) => (
                <li key={i} className="sy-card p-5 space-y-3">
                  <Skeleton h={18} w="45%" />
                  <div className="flex items-center gap-3"><Skeleton h={24} w={60} /><Skeleton h={2} w="35%" /><Skeleton h={24} w={60} /></div>
                  <Skeleton h={14} w="70%" />
                </li>
              ))}
            </ul>
          ) : sorted.length === 0 ? (
            <div className="sy-card p-8 text-center">
              <Search size={26} className="mx-auto mb-3 faint" aria-hidden />
              <h2 className="t-dm mb-1">{t("noResults")}</h2>
              <p className="t-bd muted mb-5">{t("noResultsBody")}</p>
              {nActive > 0 && <button className="sy-btn sy-btn-primary" onClick={() => dispatch({ type: "SET_FILTERS", filters: EMPTY_FILTERS })}>{t("clearFilters")}</button>}
            </div>
          ) : (
            <ul className="space-y-3">
              {sorted.map((s) => {
                const fare = baseFareFor(s);
                const shown = isReturn ? Money.round(fare - Money.pct(fare, RETURN_DISCOUNT_PCT)) : fare;
                const scarce = s.seatsAvailable <= 6;
                const insufficient = s.seatsAvailable < criteria.paxCount;
                const badges = badgeFor(s);
                return (
                  <li key={s.id} className="sy-card p-4 sm:p-5">
                    {badges.length > 0 && (
                      <div className="flex gap-2 mb-3">
                        {badges.map((b) => (
                          <span key={b.id} className="t-mi px-2 py-1 rounded inline-flex items-center gap-1" style={{ background: b.tint, color: b.color }}>
                            <b.icon size={11} aria-hidden />{b.label}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="flex flex-col sm:flex-row sm:items-center gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap mb-3">
                          <span className="t-ti">{s.carrier.name}</span>
                          <CabinBadge cabinKey={s.cabinKey} />
                          <span className="mono t-bs faint">{s.serviceNo}</span>
                        </div>
                        <div className="flex items-center gap-3">
                          <span>
                            <span className="t-dtl block leading-none">{localTime(s.departISO)}</span>
                            <span className="t-cp faint mono">{s.from}</span>
                          </span>
                          <span className="flex items-center gap-2 flex-1" style={{ maxWidth: 170 }}>
                            <span className="sy-rule" aria-hidden />
                            <span className="t-cp muted mono whitespace-nowrap">{formatDuration(s.durationMin, t)}</span>
                            <span className="sy-rule" aria-hidden />
                          </span>
                          <span>
                            <span className="t-dtl block leading-none">{localTime(s.arriveISO)}<sup className="t-cp ml-0.5">{dayOffset(s.departISO, s.arriveISO)}</sup></span>
                            <span className="t-cp faint mono">{s.to}</span>
                          </span>
                        </div>
                        <div className="flex items-center gap-3 mt-3 flex-wrap">
                          <Amenities cabin={s.cabin} />
                          <span className="t-cp muted flex items-center gap-1"><Luggage size={12} aria-hidden /> {s.cabin.baggageKg} kg</span>
                          <span className="t-cp muted flex items-center gap-1"><Armchair size={12} aria-hidden /> {s.cabin.seatPitch}</span>
                          <span className="t-cp muted flex items-center gap-1">
                            <Star size={12} style={{ color: "var(--amber)" }} fill="var(--amber)" aria-hidden /> {s.rating}
                            <span className="faint">· {s.carrier.onTime}% {t("onTime")}</span>
                          </span>
                        </div>
                      </div>
                      <div className="flex sm:flex-col items-end justify-between gap-3 sm:min-w-[170px] sm:pl-5 sm:border-l" style={{ borderColor: "var(--line)" }}>
                        <span className="text-right">
                          <span className="t-dl block leading-none" style={{ color: "var(--cobalt)" }}>{Money.format(shown, currency)}</span>
                          {isReturn && <span className="t-cp faint mono line-through">{Money.format(fare, currency)}</span>}
                          <span className="t-cp faint block">per adult, excl. tax</span>
                          <span className="t-cp block mt-1" style={{ color: scarce ? "var(--rose)" : "var(--ink-70)", fontWeight: scarce ? 600 : 400 }}>
                            {s.seatsAvailable} {t("seatsLeft")}
                          </span>
                        </span>
                        <button className="sy-btn sy-btn-primary w-full sm:w-auto" disabled={insufficient} onClick={() => onSelect(s)}>
                          {insufficient ? t("full") : t("chooseSeats")}
                        </button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function SeatStep({ state, dispatch, t, lang, currency, onExpire, telemetry, headingRef, onConfirmSeats, holding }) {
  const { segments, legCursor, criteria, holdExpiresAt, holdExpired } = state;
  const seg = segments[legCursor], service = seg.service;
  const rows = Math.ceil(service.capacity / 4);
  const complete = seg.seats.length === criteria.paxCount;
  const base = baseFareFor(service);
  const [focusSeat, setFocusSeat] = useState(() => seg.seats[0] || 1);
  const gridRef = useRef(null);

  const provisional = useMemo(() => quoteItinerary({
    segments: segments.filter((s) => s.seats.length),
    passengers: Array.from({ length: seg.seats.length || 1 }, () => ({ type: "ADT" })),
  }), [segments, seg.seats]);

  const seatState = (n) => service.soldSeats.has(n) ? "sold" : seg.seats.includes(n) ? "selected" : "free";
  const together = seatsAreTogether(seg.seats);

  function onGridKeyDown(e) {
    const col = ((focusSeat - 1) % 4) + 1, row = Math.ceil(focusSeat / 4);
    let next = null;
    if (e.key === "ArrowRight") next = col < 4 ? focusSeat + 1 : null;
    else if (e.key === "ArrowLeft") next = col > 1 ? focusSeat - 1 : null;
    else if (e.key === "ArrowDown") next = row < rows ? focusSeat + 4 : null;
    else if (e.key === "ArrowUp") next = row > 1 ? focusSeat - 4 : null;
    else if (e.key === "Home") next = (row - 1) * 4 + 1;
    else if (e.key === "End") next = Math.min(row * 4, service.capacity);
    else return;
    e.preventDefault();
    if (next && next >= 1 && next <= service.capacity) {
      setFocusSeat(next);
      gridRef.current?.querySelector(`[data-seat="${next}"]`)?.focus();
    }
  }

  function chooseForMe() {
    const picked = autoPickSeats(service, criteria.paxCount);
    telemetry.track(EVENTS.SEATS_AUTOPICKED, { service: service.serviceNo, seats: picked.join(",") });
    dispatch({ type: "SET_SEATS", seats: picked });
    setFocusSeat(picked[0]);
  }

  const cta = holding ? "Holding your seats…" : (legCursor < segments.length - 1 ? t("continueToReturn") : t("continueToDetails"));
  const onCta = () => onConfirmSeats();

  return (
    <div className="max-w-6xl mx-auto px-4 py-6 sy-enter sy-has-bar">
      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        <button onClick={() => legCursor > 0 ? dispatch({ type: "SET_LEG_CURSOR", index: legCursor - 1 }) : dispatch({ type: "GO", step: "results" })} className="sy-btn sy-btn-quiet">
          <ChevronLeft size={16} aria-hidden /> {t("back")}
        </button>
        {holdExpiresAt && <HoldTimer expiresAt={holdExpiresAt} onExpire={onExpire} t={t} />}
      </div>

      {holdExpired && (
        <div role="alert" className="sy-card p-4 mb-4 flex items-start gap-3 t-bd" style={{ borderColor: "var(--amber)", background: "var(--amber-tint)" }}>
          <Timer size={17} style={{ color: "#8A5A0B" }} className="mt-0.5 shrink-0" aria-hidden />
          <span>The 10-minute hold ran out and those seats went back into inventory. Pick again to restart it.</span>
        </div>
      )}

      <h1 className="t-dl mb-1" tabIndex={-1} ref={headingRef}>{t("chooseSeats")}</h1>
      <p className="t-bs muted mb-5">
        {criteria.roundTrip && `${legCursor === 0 ? t("outbound") : t("inbound")} · `}
        {service.carrier.name} {service.serviceNo} · {localTime(service.departISO)} · {formatDate(service.departISO.slice(0, 10), lang)}
      </p>

      <div className="grid lg:grid-cols-[1fr_320px] gap-6 items-start">
        <div className="sy-card p-5">
          <div className="flex items-center justify-between gap-3 mb-5 flex-wrap">
            <p className="t-bd font-semibold" aria-live="polite">{seg.seats.length} of {criteria.paxCount} chosen</p>
            <button className="sy-btn sy-btn-secondary sy-btn-sm" onClick={chooseForMe}>
              <Sparkles size={14} aria-hidden /> {t("chooseForMe")}
            </button>
          </div>

          {seg.seats.length > 1 && !together && (
            <p className="t-bs mb-4 p-3 rounded flex items-start gap-2" style={{ background: "var(--amber-tint)", color: "#8A5A0B" }} role="status">
              <Info size={14} className="mt-0.5 shrink-0" aria-hidden />
              Those seats aren't next to each other. Use "{t("chooseForMe")}" if you'd rather sit together.
            </p>
          )}

          <div className="flex items-center justify-center gap-4 t-cp muted mb-5 flex-wrap">
            {[["free", t("available")], ["selected", t("selected")], ["sold", t("taken")]].map(([s, label]) => (
              <span key={s} className="flex items-center gap-1.5">
                <span className="sy-seat" data-state={s} style={{ width: 22, height: 22, fontSize: 0, pointerEvents: "none" }} aria-hidden />{label}
              </span>
            ))}
            <span className="flex items-center gap-1.5"><span style={{ width: 7, height: 7, borderRadius: 99, background: "var(--amber)" }} aria-hidden /> {t("premium")}</span>
            <span className="flex items-center gap-1.5"><Accessibility size={13} aria-hidden /> {t("accessible")}</span>
          </div>

          <div className="mx-auto" style={{ maxWidth: 260 }}>
            <div className="flex justify-end mb-3">
              <span className="t-cp faint mono px-2 py-1 rounded-t" style={{ border: "1px solid var(--line)", borderBottom: 0 }}>DRIVER</span>
            </div>
            <div role="grid" aria-label="Seat map" ref={gridRef} onKeyDown={onGridKeyDown} className="space-y-2">
              {Array.from({ length: rows }, (_, r) => (
                <div role="row" key={r} className="flex gap-2 justify-center">
                  {[1, 2, null, 3, 4].map((col, ci) => {
                    if (col === null) return <span key={ci} style={{ width: 18 }} aria-hidden />;
                    const n = r * 4 + col;
                    if (n > service.capacity) return <span key={ci} style={{ width: 44 }} aria-hidden />;
                    const st = seatState(n), attrs = seatAttributes(service, n);
                    const pct = seatSurchargePct(attrs), fee = Money.round(Money.pct(base, pct));
                    return (
                      <button role="gridcell" key={ci} className="sy-seat" data-seat={n} data-state={st}
                        data-accessible={attrs.accessible} data-premium={pct > 5} disabled={st === "sold"}
                        aria-pressed={st === "selected"} tabIndex={n === focusSeat ? 0 : -1} onFocus={() => setFocusSeat(n)}
                        aria-label={`Seat ${n}. ${st === "sold" ? t("taken") : st === "selected" ? t("selected") : t("available")}. ${attrs.window ? t("window") : t("aisle")}${attrs.legroom ? ", " + t("legroom") : ""}${pct !== 0 ? `. ${pct > 0 ? "Plus" : "Less"} ${Money.format(Math.abs(fee))}` : ""}`}
                        onClick={() => dispatch({ type: "TOGGLE_SEAT", seat: n })}>
                        {st === "selected" ? <Check size={16} aria-hidden /> : n}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
            <p className="t-cp faint text-center mt-4">Arrow keys move, Enter selects.</p>
          </div>
        </div>

        <FareSummary quote={provisional} currency={currency} t={t} variant="rail" cta={cta} onCta={onCta} ctaDisabled={!complete || holding}>
          {seg.seats.length > 0 && (
            <ul className="t-bs space-y-2 mb-4 pb-4 border-b" style={{ borderColor: "var(--line)" }}>
              {seg.seats.map((n) => {
                const attrs = seatAttributes(service, n), pct = seatSurchargePct(attrs);
                return (
                  <li key={n} className="flex justify-between gap-2">
                    <span className="muted"><span className="mono font-semibold">{String(n).padStart(2, "0")}</span> {attrs.window ? t("window") : t("aisle")}{attrs.legroom ? ` · ${t("legroom")}` : ""}</span>
                    <span className="mono">{pct === 0 ? "—" : `${pct > 0 ? "+" : "−"}${Money.format(Math.abs(Money.round(Money.pct(base, pct))), currency)}`}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </FareSummary>
      </div>

      <FareSummary quote={provisional} currency={currency} t={t} variant="bar" cta={cta} onCta={onCta} ctaDisabled={!complete || holding} />
    </div>
  );
}

const PAYMENT_METHODS = [
  { id: "mpesa", label: "M-Pesa", kind: "ussd" }, { id: "mixx", label: "Mixx by Yas", kind: "ussd" },
  { id: "airtel", label: "Airtel Money", kind: "ussd" }, { id: "halopesa", label: "HaloPesa", kind: "ussd" },
  { id: "card", label: "Visa / Mastercard", kind: "card" },
];

function TravellerPanel({ index, passenger, segments, open, onOpen, dispatch, first, saved, onSave, t }) {
  const [touched, setTouched] = useState({});
  const errors = validatePassenger(passenger);
  const done = passengerComplete(passenger);
  const show = (k) => (touched[k] ? errors[k] : undefined);
  const patch = (p) => dispatch({ type: "PATCH_PASSENGER", index, patch: p });

  return (
    <div className="sy-card overflow-hidden">
      <button className="w-full flex items-center justify-between gap-3 p-4 text-left" onClick={onOpen} aria-expanded={open} style={{ minHeight: 60 }}>
        <span className="flex items-center gap-3 min-w-0">
          <span className="w-7 h-7 rounded-full flex items-center justify-center shrink-0"
            style={{ background: done ? "var(--verdant)" : "var(--field)", color: done ? "#fff" : "var(--ink-70)" }}>
            {done ? <Check size={15} aria-hidden /> : <span className="t-cp font-semibold">{index + 1}</span>}
          </span>
          <span className="min-w-0">
            <span className="t-ti block">{done ? `${passenger.lastName.toUpperCase()}/${passenger.firstName}` : `${t("travellerDetails")} ${index + 1}`}</span>
            <span className="t-cp muted block truncate">
              {PAX_TYPES[passenger.type].label} · {segments.map((s) => `${s.service.from}→${s.service.to} ${String(s.seats[index]).padStart(2, "0")}`).join(" · ")}
            </span>
          </span>
        </span>
        <ChevronDown size={18} className="shrink-0 faint" aria-hidden style={{ transform: open ? "rotate(180deg)" : "none" }} />
      </button>

      {open && (
        <div className="px-4 pb-5 border-t pt-4" style={{ borderColor: "var(--line)" }}>
          {saved.length > 0 && (
            <div className="mb-4">
              <p className="sy-label"><Bookmark size={11} aria-hidden /> {t("savedTravellers")}</p>
              <div className="flex flex-wrap gap-2">
                {saved.map((s) => (
                  <button key={s.id} className="sy-chip" onClick={() => patch({
                    firstName: s.firstName, lastName: s.lastName, documentType: s.documentType,
                    documentNumber: s.documentNumber, nationality: s.nationality,
                  })}>{s.firstName} {s.lastName}</button>
                ))}
              </div>
            </div>
          )}

          <div className="grid sm:grid-cols-2 gap-4">
            <Field label="Given name" error={show("firstName")} id={`gn-${index}`}>
              <input id={`gn-${index}`} className="sy-input" value={passenger.firstName} autoComplete="given-name"
                aria-invalid={!!show("firstName")} onBlur={() => setTouched((s) => ({ ...s, firstName: true }))}
                onChange={(e) => patch({ firstName: e.target.value })} />
            </Field>
            <Field label="Surname" error={show("lastName")} id={`sn-${index}`}>
              <input id={`sn-${index}`} className="sy-input" value={passenger.lastName} autoComplete="family-name"
                aria-invalid={!!show("lastName")} onBlur={() => setTouched((s) => ({ ...s, lastName: true }))}
                onChange={(e) => patch({ lastName: e.target.value })} />
              {index > 0 && first?.lastName && passenger.lastName !== first.lastName && (
                <button className="sy-btn sy-btn-quiet t-cp mt-1" style={{ minHeight: 32, padding: 0 }}
                  onClick={() => patch({ lastName: first.lastName, nationality: first.nationality })}>
                  Same surname as traveller 1
                </button>
              )}
            </Field>
            <Field label="Traveller type" id={`ty-${index}`}>
              <select id={`ty-${index}`} className="sy-input" value={passenger.type} onChange={(e) => patch({ type: e.target.value })}>
                {Object.entries(PAX_TYPES).map(([k, v]) => <option key={k} value={k}>{v.label}{v.discount ? ` — ${v.discount}% off` : ""}</option>)}
              </select>
            </Field>
            <Field label="Nationality" id={`na-${index}`}>
              <select id={`na-${index}`} className="sy-input" value={passenger.nationality} onChange={(e) => patch({ nationality: e.target.value })}>
                {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
              </select>
            </Field>
            <Field label="ID type" id={`dt-${index}`}>
              <select id={`dt-${index}`} className="sy-input" value={passenger.documentType} onChange={(e) => patch({ documentType: e.target.value })}>
                <option value="NID">National ID (NIDA)</option><option value="PP">Passport</option>
                <option value="VID">Voter ID</option><option value="DL">Driving licence</option>
              </select>
            </Field>
            <Field label="ID number" error={show("documentNumber")} hint="Must match the document you'll carry." id={`dn-${index}`}>
              <input id={`dn-${index}`} className="sy-input mono" value={passenger.documentNumber}
                aria-invalid={!!show("documentNumber")} onBlur={() => setTouched((s) => ({ ...s, documentNumber: true }))}
                onChange={(e) => patch({ documentNumber: e.target.value.toUpperCase() })} />
            </Field>
          </div>

          {done && (
            <button className="sy-btn sy-btn-secondary sy-btn-sm mt-4" onClick={() => onSave(passenger)}>
              <Bookmark size={14} aria-hidden /> {t("saveTraveller")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function CheckoutStep({ state, dispatch, t, lang, currency, onPay, onExpire, onApplyPromo, saved, onSaveTraveller, headingRef }) {
  const { segments, passengers, contact, payment, ancillaries, promo, criteria, holdExpiresAt, openTraveller } = state;
  const [touched, setTouched] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const errorRef = useRef(null);

  const q = useMemo(() => quoteItinerary({ segments, passengers, ancillaries, promo: promo.applied }), [segments, passengers, ancillaries, promo.applied]);
  const contactErrors = validateContact(contact);
  const incomplete = passengers.filter((p) => !passengerComplete(p)).length;
  const hasErrors = incomplete > 0 || Object.keys(contactErrors).length > 0;
  const method = PAYMENT_METHODS.find((m) => m.id === payment.method) || PAYMENT_METHODS[0];
  const e164 = toE164(contact.phone, contact.dial);
  const busy = payment.status === "processing" || payment.status === "pending";
  const refundRow = q.flexible ? null : REFUND_RULES[0];

  function submit() {
    setSubmitted(true);
    setTouched({ phone: true, email: true });
    if (hasErrors) {
      errorRef.current?.focus();
      const firstBad = passengers.findIndex((p) => !passengerComplete(p));
      if (firstBad >= 0) dispatch({ type: "OPEN_TRAVELLER", index: firstBad });
      return;
    }
    onPay(q);
  }

  const cta = `${t("payNow")} ${Money.format(q.total, currency)}`;

  return (
    <div className="max-w-6xl mx-auto px-4 py-6 sy-enter sy-has-bar">
      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        <button onClick={() => dispatch({ type: "GO", step: "seats" })} className="sy-btn sy-btn-quiet">
          <ChevronLeft size={16} aria-hidden /> {t("back")}
        </button>
        {holdExpiresAt && <HoldTimer expiresAt={holdExpiresAt} onExpire={onExpire} t={t} />}
      </div>

      <h1 className="t-dl mb-5" tabIndex={-1} ref={headingRef}>{t("travellerDetails")}</h1>

      {submitted && hasErrors && (
        <div ref={errorRef} tabIndex={-1} role="alert" className="sy-card p-4 mb-4 flex items-start gap-3 t-bd" style={{ borderColor: "var(--rose)", background: "var(--rose-tint)" }}>
          <AlertCircle size={17} style={{ color: "var(--rose)" }} className="mt-0.5 shrink-0" aria-hidden />
          <span>
            {incomplete > 0 && `${incomplete} traveller${incomplete > 1 ? "s" : ""} still need${incomplete > 1 ? "" : "s"} details. `}
            {Object.keys(contactErrors).length > 0 && "Check your contact details."}
          </span>
        </div>
      )}

      <div className="grid lg:grid-cols-[1fr_320px] gap-6 items-start">
        <div className="space-y-3">
          {passengers.map((p, i) => (
            <TravellerPanel key={i} index={i} passenger={p} segments={segments} first={passengers[0]}
              open={openTraveller === i} onOpen={() => dispatch({ type: "OPEN_TRAVELLER", index: openTraveller === i ? -1 : i })}
              dispatch={dispatch} saved={saved} onSave={onSaveTraveller} t={t} />
          ))}

          <fieldset className="sy-card p-5">
            <legend className="t-ti px-1">{t("contactDetails")}</legend>
            <p className="t-bs muted mt-1 mb-4">Your ticket and any disruption notice go here.</p>
            <div className="grid sm:grid-cols-[120px_1fr] gap-4">
              <Field label="Dial code" id="dial">
                <select id="dial" className="sy-input mono" value={contact.dial} onChange={(e) => dispatch({ type: "PATCH_CONTACT", patch: { dial: e.target.value } })}>
                  {COUNTRIES.map((c) => <option key={c.code} value={c.dial}>{c.dial}</option>)}
                </select>
              </Field>
              <Field label="Mobile number" error={touched.phone && contactErrors.phone} hint={isValidE164(e164) ? `Saved as ${e164}` : undefined} id="phone">
                <input id="phone" className="sy-input mono" inputMode="tel" autoComplete="tel" placeholder="0712 345 678"
                  aria-invalid={!!(touched.phone && contactErrors.phone)} value={contact.phone}
                  onBlur={() => setTouched((s) => ({ ...s, phone: true }))}
                  onChange={(e) => dispatch({ type: "PATCH_CONTACT", patch: { phone: e.target.value } })} />
              </Field>
              <div className="sm:col-span-2">
                <Field label="Email (optional)" error={touched.email && contactErrors.email} id="email">
                  <input id="email" className="sy-input" type="email" autoComplete="email" placeholder="you@example.com"
                    aria-invalid={!!(touched.email && contactErrors.email)} value={contact.email}
                    onBlur={() => setTouched((s) => ({ ...s, email: true }))}
                    onChange={(e) => dispatch({ type: "PATCH_CONTACT", patch: { email: e.target.value } })} />
                </Field>
              </div>
            </div>
          </fieldset>

          <fieldset className="sy-card p-5">
            <legend className="t-ti px-1">{t("extras")}</legend>
            <div className="space-y-4 mt-3">
              <div className="flex items-center justify-between gap-4">
                <span className="flex items-start gap-3 t-bd">
                  <Luggage size={17} className="mt-0.5 shrink-0" aria-hidden />
                  <span>{ANCILLARIES.extraBag.label}<span className="t-cp muted block">{Money.format(ANCILLARIES.extraBag.unit, currency)} each, up to {ANCILLARIES.extraBag.max}</span></span>
                </span>
                <select className="sy-input mono shrink-0" style={{ width: 76 }} value={ancillaries.extraBag} aria-label="Number of extra bags"
                  onChange={(e) => dispatch({ type: "PATCH_ANCILLARY", patch: { extraBag: Number(e.target.value) } })}>
                  {[0, 1, 2, 3].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </div>
              {[
                ["insurance", Umbrella, ANCILLARIES.insurance.label, `${Money.format(ANCILLARIES.insurance.unit, currency)} per traveller. Covers delay, missed departure and baggage.`],
                ["flexible", Repeat, ANCILLARIES.flexible.label, `Adds ${ANCILLARIES.flexible.pctOfFare}%. Free changes and a full refund up to departure.`],
              ].map(([key, Icon, label, desc]) => (
                <label key={key} className="flex items-start justify-between gap-4 cursor-pointer" style={{ minHeight: 44 }}>
                  <span className="flex items-start gap-3 t-bd">
                    <Icon size={17} className="mt-0.5 shrink-0" aria-hidden />
                    <span>{label}<span className="t-cp muted block">{desc}</span></span>
                  </span>
                  <input type="checkbox" className="mt-1 shrink-0" style={{ width: 20, height: 20 }} checked={ancillaries[key]}
                    onChange={(e) => dispatch({ type: "PATCH_ANCILLARY", patch: { [key]: e.target.checked } })} />
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="sy-card p-5">
            <legend className="t-ti px-1">{t("payment")}</legend>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mt-3">
              {PAYMENT_METHODS.map((m) => (
                <button key={m.id} onClick={() => dispatch({ type: "PATCH_PAYMENT", patch: { method: m.id } })} aria-pressed={payment.method === m.id}
                  className="rounded p-3 t-bs font-semibold" style={{
                    minHeight: 52, border: "1.5px solid " + (payment.method === m.id ? "var(--cobalt)" : "var(--line-2)"),
                    background: payment.method === m.id ? "var(--cobalt-tint)" : "var(--surface)",
                    color: payment.method === m.id ? "var(--cobalt-deep)" : "var(--ink)",
                  }}>{m.label}</button>
              ))}
            </div>
            {method.kind === "ussd" ? (
              <p className="t-bs muted mt-4">A prompt for {Money.format(q.total)} goes to {isValidE164(e164) ? e164 : "your mobile number"}. Approve it with your PIN.</p>
            ) : (
              <div className="grid sm:grid-cols-2 gap-4 mt-4">
                <div className="sm:col-span-2"><Field label="Card number" id="cc"><input id="cc" className="sy-input mono" inputMode="numeric" autoComplete="cc-number" /></Field></div>
                <Field label="Name on card" id="ccn"><input id="ccn" className="sy-input" autoComplete="cc-name" /></Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Expiry" id="cce"><input id="cce" className="sy-input mono" placeholder="MM/YY" autoComplete="cc-exp" /></Field>
                  <Field label="CVC" id="ccc"><input id="ccc" className="sy-input mono" inputMode="numeric" autoComplete="cc-csc" /></Field>
                </div>
              </div>
            )}

            <div className="mt-5 pt-4 border-t space-y-2" style={{ borderColor: "var(--line)" }}>
              <p className="t-bs muted flex items-start gap-2"><Fingerprint size={15} className="mt-0.5 shrink-0" style={{ color: "var(--verdant)" }} aria-hidden />
                Your ticket is signed. The gate verifies it offline, so a copied code can't board ahead of you.</p>
              <p className="t-bs muted flex items-start gap-2"><RefreshCw size={15} className="mt-0.5 shrink-0" style={{ color: "var(--verdant)" }} aria-hidden />
                {q.flexible ? "Flexible fare: free changes and a full refund up to departure."
                  : `Cancel ${refundRow.label.toLowerCase()} for a ${refundRow.refundPct}% refund of the fare. The service fee isn't refundable.`}</p>
              <p className="t-bs muted flex items-start gap-2"><AlertTriangle size={15} className="mt-0.5 shrink-0" style={{ color: "var(--verdant)" }} aria-hidden />
                If the coach is delayed 90 minutes or more, you're entitled to compensation and a rebooking automatically.</p>
            </div>

            <label className="flex items-center gap-2 mt-4 t-cp muted cursor-pointer" style={{ minHeight: 44 }}>
              <input type="checkbox" checked={payment.simulateDecline} style={{ width: 18, height: 18 }}
                onChange={(e) => dispatch({ type: "PATCH_PAYMENT", patch: { simulateDecline: e.target.checked } })} />
              Test mode: force the gateway to decline
            </label>

            {payment.status === "failed" && (
              <div role="alert" className="mt-4 p-4 rounded t-bs flex items-start gap-3" style={{ background: "var(--rose-tint)", color: "#8E2A1B" }}>
                <X size={15} className="mt-0.5 shrink-0" aria-hidden />
                <span>{payment.error} Your seats are still held. Attempt {payment.attempt} — a retry reuses the same idempotency key, so you can't be charged twice.</span>
              </div>
            )}
          </fieldset>
        </div>

        <FareSummary quote={q} currency={currency} t={t} variant="rail" cta={cta} onCta={submit} ctaDisabled={busy}
          secondary={<p className="t-cp faint mt-3">Paying accepts the conditions of carriage.</p>}>
          {segments.map((s, i) => (
            <div key={i} className="mb-3 pb-3 border-b" style={{ borderColor: "var(--line)" }}>
              <p className="t-mi faint">{criteria.roundTrip ? (i === 0 ? t("outbound") : t("inbound")) : "Journey"}</p>
              <p className="t-bd font-semibold">{s.service.carrier.name}</p>
              <p className="t-cp muted mono">{s.service.from}→{s.service.to} · {formatDate(s.service.departISO.slice(0, 10), lang)} · {localTime(s.service.departISO)}</p>
            </div>
          ))}
          <div className="mb-4">
            <label className="sy-label" htmlFor="promo"><Tag size={11} aria-hidden /> {t("promoCode")}</label>
            <div className="flex gap-2">
              <input id="promo" className="sy-input mono uppercase" placeholder="SAFARI10" value={promo.input} aria-invalid={!!promo.error}
                onChange={(e) => dispatch({ type: "PATCH_PROMO", patch: { input: e.target.value.toUpperCase(), error: null } })} />
              <button className="sy-btn sy-btn-secondary shrink-0" onClick={onApplyPromo}>{t("apply")}</button>
            </div>
            {promo.error && <p className="sy-err" role="alert"><AlertCircle size={12} className="shrink-0 mt-px" aria-hidden />{promo.error}</p>}
            {promo.applied && (
              <p className="t-cp mt-2 flex items-center gap-1" style={{ color: "var(--verdant)" }}>
                <Check size={13} aria-hidden /> {PROMOTIONS.find((p) => p.code === promo.applied)?.label}
              </p>
            )}
          </div>
        </FareSummary>
      </div>

      <FareSummary quote={q} currency={currency} t={t} variant="bar" cta={busy ? "Waiting…" : cta} onCta={submit} ctaDisabled={busy} />
    </div>
  );
}

function Stamp({ status }) {
  const map = { CONFIRMED: { label: "Confirmed", color: "var(--verdant)" }, REFUNDED: { label: "Refunded", color: "var(--ink-45)" } };
  const s = map[status] || map.CONFIRMED;
  return <span className="sy-stamp" style={{ color: s.color }}>{s.label}</span>;
}

function DisruptionNotice({ booking, disruption, currency, lang, t }) {
  const outcome = disruptionOutcome(disruption, booking);
  const options = useMemo(() => rebookingOptions(booking, disruption), [booking, disruption]);
  const [rebooked, setRebooked] = useState(null);
  if (!outcome) return null;

  return (
    <section className="sy-card p-5 mb-5" style={{ borderColor: "var(--amber)", borderWidth: 2 }} role="alert">
      <div className="flex items-start gap-3">
        <AlertTriangle size={22} style={{ color: "#8A5A0B" }} className="shrink-0 mt-0.5" aria-hidden />
        <div className="min-w-0 flex-1">
          <h2 className="t-dm mb-1">
            {disruption.kind === "CANCEL" ? "Your coach has been cancelled" : `Your coach is delayed ${disruption.delayMin} minutes`}
          </h2>
          <p className="t-bd muted mb-3">{disruption.reason}</p>

          {outcome.revisedDeparture && (
            <p className="t-bd mb-3">
              New departure <span className="mono font-semibold">{localTime(outcome.revisedDeparture)}</span>
            </p>
          )}

          {outcome.compensation > 0 && (
            <div className="p-3 rounded mb-4" style={{ background: "var(--verdant-tint)" }}>
              <p className="t-bd font-semibold" style={{ color: "var(--verdant)" }}>
                {Money.format(outcome.compensation, currency)} compensation due
              </p>
              <p className="t-cp muted">
                {outcome.rule.label} — {outcome.rule.compensationPct}% of your fare under the published policy. Paid to your mobile money account within 5 business days.
              </p>
            </div>
          )}

          {outcome.rebookOffered && !rebooked && options.length > 0 && (
            <>
              <p className="t-mi faint mb-2">Rebook free of charge</p>
              <ul className="space-y-2">
                {options.map((o) => (
                  <li key={o.id} className="flex items-center justify-between gap-3 p-3 rounded" style={{ background: "var(--field)" }}>
                    <span className="min-w-0">
                      <span className="t-bd font-semibold block">{o.carrier.name}</span>
                      <span className="t-cp muted mono">
                        {o.serviceNo} · {formatDate(o.departISO.slice(0, 10), lang)} {localTime(o.departISO)} · {o.seatsAvailable} seats
                      </span>
                    </span>
                    <button className="sy-btn sy-btn-primary sy-btn-sm shrink-0" onClick={() => setRebooked(o)}>Move to this</button>
                  </li>
                ))}
              </ul>
            </>
          )}

          {rebooked && (
            <p className="t-bd p-3 rounded flex items-start gap-2" style={{ background: "var(--verdant-tint)", color: "var(--verdant)" }}>
              <Check size={16} className="mt-0.5 shrink-0" aria-hidden />
              Moved to {rebooked.carrier.name} {rebooked.serviceNo}, departing {localTime(rebooked.departISO)}. A replacement ticket is on its way to your phone.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

function TicketStep({ booking, disruption, t, lang, currency, onCancel, onNew, headingRef }) {
  const [sent, setSent] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const { segments, passengers, quote: q, locator, tickets, contact, status, refund, fiscal, barcode } = booking;
  const refundInfo = useMemo(() => refundQuote(booking), [booking]);
  const cancelled = status === "REFUNDED";
  const countdown = countdownTo(segments[0].service.departISO);

  return (
    <div className="max-w-2xl mx-auto px-4 py-8 sy-enter">
      <div className="text-center mb-6 sy-noprint">
        <h1 className="t-dl" tabIndex={-1} ref={headingRef}>{cancelled ? "Booking cancelled" : t("confirmed")}</h1>
        <p className="t-bd muted mt-2">
          {cancelled ? `${Money.format(refund.amount, currency)} returns to ${contact.phoneE164} within 5 business days.`
            : `We've sent your ticket to ${contact.phoneE164}. Reference ${locator}.`}
        </p>
        {!cancelled && countdown && (
          <p className="t-bs mt-3 inline-flex items-center gap-2 px-3 py-2 rounded" style={{ background: "var(--cobalt-tint)", color: "var(--cobalt-deep)" }}>
            <Clock size={14} aria-hidden /> {t("departsIn")} <span className="mono font-semibold">{countdown}</span>
          </p>
        )}
      </div>

      {!cancelled && disruption && <DisruptionNotice booking={booking} disruption={disruption} currency={currency} lang={lang} t={t} />}

      <article className="sy-card sy-doc" style={{ opacity: cancelled ? 0.7 : 1 }}>
        <header className="sy-plate px-5 pt-5 pb-6" style={{ borderRadius: "9px 9px 0 0" }}>
          <div className="flex items-start justify-between gap-3">
            <span className="flex items-center gap-2">
              <Bus size={16} aria-hidden /><span className="t-ti">SafariTiketi</span>
              <span className="t-cp" style={{ color: "#BCCBF0" }}>{t("eticket")}</span>
            </span>
            <span className="text-right">
              <span className="t-mi block" style={{ color: "#BCCBF0" }}>{t("locator")}</span>
              <span className="sy-plate-code block text-xl" style={{ color: "var(--amber)" }}>{locator}</span>
            </span>
          </div>
        </header>

        {segments.map((seg, i) => {
          const from = stationBy(seg.service.from), to = stationBy(seg.service.to);
          return (
            <section key={i} className={i > 0 ? "border-t" : ""} style={{ borderColor: "var(--line)" }}>
              <div className="px-5 pt-5">
                <div className="flex items-center justify-between gap-2 mb-3">
                  <p className="t-mi faint">{segments.length > 1 ? (i === 0 ? t("outbound") : t("inbound")) : "Journey"}</p>
                  {i === 0 && <Stamp status={status} />}
                </div>
                <div className="flex items-end gap-3">
                  <span>
                    <span className="t-cp faint mono block">{from.code}</span>
                    <span className="t-dm block">{from.name}</span>
                    <span className="t-dtl block mt-1">{localTime(seg.service.departISO)}</span>
                  </span>
                  <span className="flex-1 flex items-center gap-2 pb-3" style={{ color: "var(--cobalt)" }} aria-hidden>
                    <span className="sy-dot" /><span className="sy-rule" style={{ background: "var(--line-2)" }} /><Bus size={14} />
                  </span>
                  <span className="text-right">
                    <span className="t-cp faint mono block">{to.code}</span>
                    <span className="t-dm block">{to.name}</span>
                    <span className="t-dtl block mt-1">{localTime(seg.service.arriveISO)}{dayOffset(seg.service.departISO, seg.service.arriveISO)}</span>
                  </span>
                </div>
              </div>
              <dl className="px-5 py-5 grid grid-cols-2 sm:grid-cols-3 gap-4">
                {[
                  ["Date", formatDate(seg.service.departISO.slice(0, 10), lang)],
                  ["Carrier", seg.service.carrier.name], ["Service", seg.service.serviceNo],
                  ["Class", `${seg.service.cabin.label} · ${CABINS[seg.service.cabinKey].fareBasis}`],
                  ["Boards from", from.terminal],
                  ["Boarding closes", localTime(addMinutesISO(seg.service.departISO, -20))],
                ].map(([k, v]) => (
                  <div key={k}><dt className="t-mi faint">{k}</dt><dd className="t-bs font-semibold">{v}</dd></div>
                ))}
              </dl>
            </section>
          );
        })}

        <div className="px-5 pb-5 pt-5 border-t overflow-x-auto" style={{ borderColor: "var(--line)" }}>
          <table className="w-full text-left t-bs">
            <thead>
              <tr>
                <th className="t-mi faint font-normal pb-2">Traveller</th>
                <th className="t-mi faint font-normal pb-2">Type</th>
                {segments.map((s, i) => <th key={i} className="t-mi faint font-normal pb-2">{s.service.from}→{s.service.to}</th>)}
                <th className="t-mi faint font-normal pb-2">Ticket number</th>
              </tr>
            </thead>
            <tbody>
              {passengers.map((p, i) => (
                <tr key={i} className="border-t" style={{ borderColor: "var(--line)" }}>
                  <td className="py-2 font-semibold whitespace-nowrap">{p.lastName.toUpperCase()}/{p.firstName}</td>
                  <td className="py-2 mono">{p.type}</td>
                  {segments.map((s, si) => <td key={si} className="py-2 mono font-semibold">{String(s.seats[i]).padStart(2, "0")}</td>)}
                  <td className="py-2 mono">{tickets[i]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="sy-perf p-5">
          <div className="flex items-center justify-between gap-5 flex-wrap">
            <div className="min-w-0">
              <p className="t-mi faint mb-2">Scan at boarding</p>
              <p className="sy-plate-code text-2xl">{locator}</p>
              <p className="t-cp mt-2 flex items-center gap-1.5" style={{ color: "var(--verdant)" }}>
                <Fingerprint size={12} aria-hidden /> Signed · key {barcode.slice(-18, -16)}
              </p>
            </div>
            <div className="p-2 rounded shrink-0" style={{ background: "#fff", border: "1px solid var(--line)" }}>
              <QRCode payload={barcode} size={128} label={`Boarding code for booking ${locator}`} />
            </div>
          </div>
        </div>
      </article>

      <section className="sy-card sy-doc sy-carbon p-5 mt-5">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            <h2 className="t-ti flex items-center gap-2"><Receipt size={15} aria-hidden /> {t("fiscalReceipt")}</h2>
            <p className="t-cp muted mt-1">{fiscal.name} · TIN {fiscal.tin} · VRN {fiscal.vrn}</p>
          </div>
          <p className="t-cp mono muted text-right">{fiscal.receiptNo}<br />Z {fiscal.zNumber}</p>
        </div>
        <dl className="t-bs space-y-1.5">
          {q.breakdown.map((b) => (
            <div key={b.code} className="flex justify-between gap-3">
              <dt className="muted">{b.label} <span className="mono t-cp faint">[{b.code}]</span></dt>
              <dd className="mono">{Money.format(b.amount, currency)}</dd>
            </div>
          ))}
          <div className="flex justify-between pt-2 mt-1 border-t font-semibold" style={{ borderColor: "var(--line-2)" }}>
            <dt>Total paid</dt><dd className="mono">{Money.format(q.total, currency)}</dd>
          </div>
        </dl>
        <p className="t-cp mono muted mt-4">Verification {fiscal.verificationCode} · {fiscal.verifyUrl}</p>
      </section>

      {!cancelled && (
        <>
          <div className="grid sm:grid-cols-3 gap-3 mt-5 sy-noprint">
            <button className="sy-btn sy-btn-secondary" onClick={() => window.print()}><Printer size={15} aria-hidden /> {t("print")}</button>
            <button className="sy-btn sy-btn-secondary" onClick={() => setSent("wallet")}><Wallet size={15} aria-hidden /> {t("addToWallet")}</button>
            <button className="sy-btn sy-btn-secondary" onClick={() => setSent("send")}><Share2 size={15} aria-hidden /> {t("sendTicket")}</button>
          </div>
          {sent && (
            <p className="t-bs text-center mt-3 sy-noprint" style={{ color: "var(--verdant)" }} role="status">
              {sent === "wallet" ? `Pass generated for ${locator}.` : `Sent to ${contact.phoneE164}${contact.email ? ` and ${contact.email}` : ""}.`}
            </p>
          )}
          <p className="t-cp faint text-center mt-3 sy-noprint flex items-center justify-center gap-1.5">
            <WifiOff size={12} aria-hidden /> Screenshot it too — the signature verifies with no network.
          </p>
        </>
      )}

      <section className="sy-card p-5 mt-5">
        <h2 className="t-ti mb-3">{t("conditions")}</h2>
        <ul className="t-bs muted space-y-2 list-disc pl-5">
          <li>Boarding opens 60 minutes and closes 20 minutes before departure.</li>
          <li>Carry the ID recorded on the ticket. Names must match the document.</li>
          <li>Checked baggage up to {segments[0].service.cabin.baggageKg} kg per traveller is included.</li>
          <li>Fare basis {CABINS[segments[0].service.cabinKey].fareBasis}{q.flexible ? " with the flexible option — changes free, refunds full up to departure." : " — changes allowed up to 4 hours before departure."}</li>
        </ul>
        <h3 className="t-ti mt-5 mb-2">Disruption policy</h3>
        <table className="w-full t-bs">
          <tbody>
            {DISRUPTION_POLICY.filter((r) => r.compensationPct > 0).map((r) => (
              <tr key={r.code} className="border-t" style={{ borderColor: "var(--line)" }}>
                <td className="py-2 muted">{r.label}</td>
                <td className="py-2 mono text-right font-semibold">{r.compensationPct}% of fare</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {!cancelled && (
        <div className="mt-5 sy-noprint">
          {!confirming ? (
            <button className="sy-btn sy-btn-danger w-full" onClick={() => setConfirming(true)}>{t("cancelBooking")}</button>
          ) : (
            <div className="sy-card p-5" style={{ borderColor: "var(--rose)" }}>
              <p className="t-ti mb-2">Cancel booking {locator}?</p>
              <p className="t-bs muted mb-4">
                First departure is in {Math.max(0, Math.round(refundInfo.hours))} hours — {refundInfo.rule.label.toLowerCase()}, so {refundInfo.rule.refundPct}% applies.
                <strong className="block mt-2" style={{ color: "var(--ink)" }}>{t("refundDue")}: {Money.format(refundInfo.amount, currency)}</strong>
              </p>
              <div className="flex gap-3">
                <button className="sy-btn sy-btn-secondary flex-1" onClick={() => setConfirming(false)}>Keep booking</button>
                <button className="sy-btn sy-btn-danger flex-1" onClick={() => onCancel(refundInfo)}>Confirm cancellation</button>
              </div>
            </div>
          )}
        </div>
      )}

      <button className="sy-btn sy-btn-quiet w-full mt-6 sy-noprint" onClick={onNew}>{t("bookAnother")} →</button>
    </div>
  );
}

function ManageStep({ dispatch, t, onOpen, headingRef }) {
  const [locator, setLocator] = useState(""), [surname, setSurname] = useState("");
  const [error, setError] = useState(null), [busy, setBusy] = useState(false);

  async function retrieve() {
    setBusy(true); setError(null);
    const b = await repo.getBooking(locator.trim());
    setBusy(false);
    if (!b) return setError("No booking matches that reference.");
    if (!b.passengers.some((p) => p.lastName.toLowerCase() === surname.trim().toLowerCase()))
      return setError("The surname doesn't match this reference.");
    onOpen(b);
  }

  return (
    <div className="max-w-md mx-auto px-4 py-12 sy-enter">
      <button onClick={() => dispatch({ type: "GO", step: "search" })} className="sy-btn sy-btn-quiet mb-4">
        <ChevronLeft size={16} aria-hidden /> {t("back")}
      </button>
      <div className="sy-card p-6">
        <h1 className="t-dm mb-2" tabIndex={-1} ref={headingRef}>{t("retrieve")}</h1>
        <p className="t-bs muted mb-5">Two identifiers, as at any ticket counter: the reference on your ticket, and the surname it was issued in.</p>
        <div className="space-y-4">
          <Field label={t("locator")} id="loc">
            <input id="loc" className="sy-input mono uppercase" style={{ letterSpacing: ".2em" }} maxLength={6} placeholder="ACDEF2"
              value={locator} onChange={(e) => setLocator(e.target.value.toUpperCase())} />
          </Field>
          <Field label={t("surname")} id="sur">
            <input id="sur" className="sy-input" value={surname} autoComplete="family-name" onChange={(e) => setSurname(e.target.value)} />
          </Field>
        </div>
        {error && <p className="sy-err" role="alert"><AlertCircle size={13} className="shrink-0 mt-px" aria-hidden />{error}</p>}
        <button className="sy-btn sy-btn-primary w-full mt-5" disabled={locator.length !== 6 || !surname.trim() || busy} onClick={retrieve}>
          {busy ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <Ticket size={16} aria-hidden />} {t("retrieve")}
        </button>
      </div>
    </div>
  );
}

/* ═══ App ═════════════════════════════════════════════════════════════════ */

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [lang, setLang] = useState("en");
  const [currency, setCurrency] = useState("TZS");
  const [bookings, setBookings] = useState([]);
  const [travellers, setTravellers] = useState([]);
  const [disruptions, setDisruptions] = useState({});
  const [announcement, setAnnouncement] = useState("");
  const [online, setOnline] = useState(true);
  const [holding, setHolding] = useState(false);
  const telemetry = useRef(createTelemetry()).current;
  const headingRef = useRef(null);

  const t = useCallback((k) => STRINGS[lang][k] ?? STRINGS.en[k] ?? k, [lang]);

  const reload = useCallback(async () => {
    setBookings(await repo.listBookings());
    setTravellers(await repo.listTravellers());
    setDisruptions(await repo.listDisruptions());
  }, []);
  useEffect(() => { reload(); }, [reload, state.booking]);

  useEffect(() => {
    window.scrollTo(0, 0);
    const id = setTimeout(() => headingRef.current?.focus(), 60);
    return () => clearTimeout(id);
  }, [state.step, state.legCursor, role]);

  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    setOnline(navigator.onLine !== false);
    window.addEventListener("online", on); window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);

  const onExpire = useCallback(() => {
    // The row has already lapsed server-side; this only tidies the UI.
    telemetry.track(EVENTS.HOLD_EXPIRED);
    setAnnouncement("Seat hold expired. Please choose your seats again.");
    dispatch({ type: "HOLD_EXPIRED" });
  }, [telemetry]);

  async function handleSearch() {
    dispatch({ type: "SEARCH_START" });
    setAnnouncement(t("searching"));
    await new Promise((r) => setTimeout(r, 550));
    const services = searchServices(state.criteria);
    telemetry.track(EVENTS.SEARCH_SUBMITTED, { route: `${state.criteria.from}-${state.criteria.to}`, results: services.length });
    dispatch({ type: "SEARCH_DONE", services });
    setAnnouncement(`${services.length} services found.`);
  }

  function handleSelectService(service) {
    telemetry.track(EVENTS.SERVICE_SELECTED, { service: service.serviceNo, leg: state.legCursor });
    const needsReturn = state.criteria.roundTrip && state.legCursor === 0;
    dispatch({
      type: "SELECT_SERVICE", service,
      nextResults: needsReturn ? searchServices({ from: state.criteria.to, to: state.criteria.from, date: state.criteria.returnDate }) : null,
    });
    setAnnouncement(needsReturn ? "Outbound chosen. Now choose the return service." : "Service chosen. Choose your seats.");
  }

  function handleApplyPromo() {
    const res = validatePromo(state.promo.input, { paxCount: state.criteria.paxCount, isReturn: state.segments.length > 1 });
    if (res.ok) {
      telemetry.track(EVENTS.PROMO_APPLIED, { code: res.promo.code });
      dispatch({ type: "PATCH_PROMO", patch: { applied: res.promo.code, error: null } });
      setAnnouncement(`Promotion ${res.promo.code} applied.`);
    } else {
      telemetry.track(EVENTS.PROMO_REJECTED, { reason: res.reason });
      dispatch({ type: "PATCH_PROMO", patch: { applied: null, error: res.reason } });
    }
  }

  /**
   * Acquire the hold from the server before leaving the seat map.
   *
   * The seat map is optimistic while the traveller is choosing — tapping a seat
   * costs nothing. The authoritative claim happens once, here, and a refusal
   * sends them back with the seat named rather than failing at payment.
   */
  async function handleConfirmSeats() {
    const leg = state.segments[state.legCursor];
    if (!leg || leg.seats.length !== state.criteria.paxCount) return;

    setHolding(true);
    try {
      const held = await api.holdSeats(leg.service.id, leg.seats, Math.floor(HOLD_DURATION_MS / 1000));
      dispatch({ type: "SET_SEATS", seats: held.seats, holdToken: held.holdToken, expiresAt: held.expiresAt });
      dispatch({ type: "SEATS_NEXT" });
      setAnnouncement("Seats held. Enter traveller details.");
    } catch (err) {
      if (err?.type === "seat-taken") {
        // Someone else committed first. Clear the selection and say which seat.
        dispatch({ type: "SET_SEATS", seats: [] });
        setAnnouncement(err.detail);
      } else {
        setAnnouncement("Could not hold those seats. Please try again.");
      }
    } finally {
      setHolding(false);
    }
  }

  async function handleSaveTraveller(p) {
    const tr = { id: `${p.documentType}-${p.documentNumber}`.replace(/[^\w-]/g, ""), ...p };
    await repo.saveTraveller(tr);
    telemetry.track(EVENTS.TRAVELLER_SAVED);
    setTravellers(await repo.listTravellers());
    setAnnouncement(`${p.firstName} ${p.lastName} saved for next time.`);
  }

  /**
   * Issuance is a server call now.
   *
   * The prototype minted the locator, the ticket numbers and the signature here
   * in the browser. That is exactly the vulnerability this rewrite removes: a
   * client that can sign can forge. The Edge Function holds the key, confirms
   * the seat hold and writes the booking in one transaction, and returns a
   * finished ticket this bundle could not have produced.
   */
  async function handlePay(q) {
    const key = state.payment.idempotencyKey || `pay_${Date.now()}_${generateRecordLocator()}`;
    telemetry.track(EVENTS.PAYMENT_INITIATED, { method: state.payment.method, amount: q.total });
    dispatch({ type: "PAYMENT_START", key });

    if (state.payment.simulateDecline) {
      await new Promise((r) => setTimeout(r, 900));
      telemetry.track(EVENTS.PAYMENT_DECLINED, { code: 51 });
      dispatch({ type: "PAYMENT_FAILED", error: "Declined by the provider (code 51: insufficient funds)." });
      return;
    }

    dispatch({ type: "PAYMENT_PENDING" });

    try {
      const issued = await api.issueTicket({
        idempotencyKey: key,
        holdToken: state.holdToken,
        service: state.segments[0].service,
        passengers: state.passengers,
        contact: { ...state.contact, phone: state.contact.phone, dial: state.contact.dial },
        ancillaries: state.ancillaries,
        promoCode: state.promo.applied,
        paymentMethod: state.payment.method,
      });

      const booking = {
        locator: issued.locator,
        status: issued.status ?? "CONFIRMED",
        issuedAt: issued.issuedAt,
        segments: state.segments.map((seg, i) => ({ ...seg, seats: i === 0 ? issued.seats : seg.seats })),
        passengers: state.passengers,
        contact: { ...state.contact, phoneE164: toE164(state.contact.phone, state.contact.dial) },
        quote: q,
        tickets: issued.tickets,
        // Signed server-side. The client renders it and never regenerates it.
        barcode: issued.barcode,
        ancillaries: state.ancillaries,
        fiscal: issueFiscalReceipt(issued.locator, q.total, issued.issuedAt),
      };

      telemetry.track(EVENTS.TICKET_ISSUED, { locator: issued.locator, total: q.total });
      setAnnouncement(`Booking confirmed. Reference ${issued.locator}.`);
      dispatch({ type: "BOOKING_ISSUED", booking });
    } catch (err) {
      // The seat hold is the common failure and deserves its own wording.
      const expired = err?.type?.includes("hold-expired");
      telemetry.track(EVENTS.PAYMENT_DECLINED, { reason: err?.type ?? "error" });
      dispatch({
        type: "PAYMENT_FAILED",
        error: expired
          ? "Your seats expired during checkout. Please choose again."
          : (err?.detail ?? "We could not complete the booking. No payment was taken."),
      });
    }
  }

  async function handleCancel(refundInfo) {
    const surname = state.booking?.passengers?.[0]?.lastName ?? "";
    try {
      await api.cancelBooking(state.booking.locator, surname, refundInfo);
      telemetry.track(EVENTS.BOOKING_CANCELLED, { locator: state.booking.locator });
      setAnnouncement(`Booking cancelled. ${Money.format(refundInfo.amount)} will be refunded.`);
      dispatch({
        type: "BOOKING_CANCELLED",
        refund: { amount: refundInfo.amount, pct: refundInfo.rule.refundPct, at: new Date().toISOString() },
      });
    } catch {
      setAnnouncement("We could not cancel that booking. Please contact support.");
    }
  }

  const activeDisruption = state.booking
    ? disruptions[state.booking.segments[0].service.serviceNo] || null
    : null;

  const showPlate = ["results", "seats", "checkout"].includes(state.step);

  return (
    <div className="sy">
      <Styles />
      <Announcer message={announcement} />
      <a href="#main" className="sy-skip">Skip to main content</a>

      <Header lang={lang} setLang={setLang} currency={currency} setCurrency={setCurrency}
        onHome={() => dispatch({ type: "RESET" })} onManage={() => dispatch({ type: "GO", step: "manage" })} t={t} />

      <ProgressStripe current={STEP_INDEX[state.step]} t={t} />

      {showPlate && (
        <RoutePlate criteria={state.criteria} segments={state.segments} lang={lang} compact={state.step !== "results"}
          onEdit={state.step === "results" ? () => dispatch({ type: "GO", step: "search" }) : undefined} t={t} />
      )}

      {!online && (
        <p role="status" className="t-bs px-4 py-3 text-center sy-noprint" style={{ background: "var(--amber-tint)", color: "#8A5A0B" }}>
          <WifiOff size={13} className="inline mr-1.5" aria-hidden /> {t("offline")}
        </p>
      )}

      <main id="main">
        <ErrorBoundary>
          {state.step === "search" && (
            <SearchStep criteria={state.criteria} dispatch={dispatch} onSearch={handleSearch} t={t}
              recent={bookings} headingRef={headingRef} onOpenBooking={(b) => dispatch({ type: "OPEN_BOOKING", booking: b })} />
          )}
          {state.step === "results" && (
            <ResultsStep state={state} dispatch={dispatch} t={t} lang={lang} currency={currency}
              onSelect={handleSelectService} headingRef={headingRef} />
          )}
          {state.step === "seats" && state.segments.length > 0 && (
            <SeatStep state={state} dispatch={dispatch} t={t} lang={lang} currency={currency}
              onExpire={onExpire} telemetry={telemetry} headingRef={headingRef}
              onConfirmSeats={handleConfirmSeats} holding={holding} />
          )}
          {state.step === "checkout" && (
            <CheckoutStep state={state} dispatch={dispatch} t={t} lang={lang} currency={currency}
              onPay={handlePay} onExpire={onExpire} onApplyPromo={handleApplyPromo}
              saved={travellers} onSaveTraveller={handleSaveTraveller} headingRef={headingRef} />
          )}
          {state.step === "ticket" && state.booking && (
            <TicketStep booking={state.booking} disruption={activeDisruption} t={t} lang={lang} currency={currency}
              onCancel={handleCancel} onNew={() => dispatch({ type: "RESET" })} headingRef={headingRef} />
          )}
          {state.step === "manage" && (
            <ManageStep dispatch={dispatch} t={t} headingRef={headingRef} onOpen={(b) => dispatch({ type: "OPEN_BOOKING", booking: b })} />
          )}
        </ErrorBoundary>
      </main>

      <footer className="sy-noprint mt-10" style={{ background: "var(--surface)", borderTop: "1px solid var(--line)" }}>
        <div className="max-w-6xl mx-auto px-4 py-6 flex flex-wrap items-center justify-between gap-3 t-cp muted">
          <p>SafariTiketi — reference implementation. Inventory and payments are simulated; no funds move.</p>
          <p className="mono">TZS · EAT (UTC+03:00) · VAT {VAT_RATE}% · QR ECC-M · HMAC-SHA256</p>
        </div>
      </footer>
    </div>
  );
}
