/**
 * The single fare authority. Nothing outside this module may compute a payable
 * amount; `quoteItinerary` returns a fully itemised quote whose breakdown sums
 * exactly to its total, which is asserted in the tests.
 */
import { Money, BASE_CURRENCY } from "./money.js";
import { seatAttributes, seatSurchargePct } from "./inventory.js";

export const VAT_RATE = 18, SERVICE_FEE_PER_PAX = 1500, RETURN_DISCOUNT_PCT = 10;

export const PAX_TYPES = {
  ADT: { label: "Adult", discount: 0 }, CHD: { label: "Child (2–11)", discount: 40 },
  INF: { label: "Infant (under 2, on lap)", discount: 90 }, SNR: { label: "Senior (60+)", discount: 15 },
};
export const ANCILLARIES = {
  extraBag: { label: "Extra checked bag", unit: 5000, max: 3 },
  insurance: { label: "Travel cover", unit: 3500 },
  flexible: { label: "Flexible fare", pctOfFare: 12 },
};
export const PROMOTIONS = [
  { code: "SAFARI10", label: "10% off the base fare", discountPct: 10, minPax: 1 },
  { code: "RUDIA15", label: "15% off return journeys", discountPct: 15, minPax: 1, requiresReturn: true },
  { code: "GROUP20", label: "20% off for 4 or more travellers", discountPct: 20, minPax: 4 },
];

export function validatePromo(code, { paxCount, isReturn }) {
  const promo = PROMOTIONS.find((p) => p.code === String(code).trim().toUpperCase());
  if (!promo) return { ok: false, reason: "That code isn't recognised." };
  if (promo.minPax && paxCount < promo.minPax) return { ok: false, reason: `Needs at least ${promo.minPax} travellers.` };
  if (promo.requiresReturn && !isReturn) return { ok: false, reason: "Applies to return journeys only." };
  return { ok: true, promo };
}
export function demandMultiplier(loadFactor) {
  if (loadFactor > 0.85) return 1.25;
  if (loadFactor > 0.65) return 1.12;
  if (loadFactor < 0.30) return 0.92;
  return 1;
}
export function baseFareFor(service) {
  return Money.round((service.distance * service.cabin.ratePerKm) / 100 * demandMultiplier(service.loadFactor));
}

export function quoteItinerary({ segments, passengers, ancillaries = {}, promo = null }) {
  const isReturn = segments.length > 1;
  const segmentQuotes = segments.map((seg, segIndex) => {
    const base = baseFareFor(seg.service);
    const returnDiscount = segIndex > 0 ? RETURN_DISCOUNT_PCT : 0;
    const lines = passengers.map((pax, i) => {
      const seat = seg.seats[i];
      const paxType = PAX_TYPES[pax.type] || PAX_TYPES.ADT;
      const attrs = seatAttributes(seg.service, seat);
      const seatPct = seatSurchargePct(attrs);
      const afterPax = base - Money.pct(base, paxType.discount);
      const afterReturn = afterPax - Money.pct(afterPax, returnDiscount);
      const seatFee = Money.round(Money.pct(afterReturn, Math.max(seatPct, 0)) - Money.pct(afterReturn, Math.max(-seatPct, 0)));
      return { paxIndex: i, paxType: pax.type, seat, attrs, seatPct, seatFee, fare: Money.round(afterReturn) + seatFee };
    });
    return { segIndex, service: seg.service, base, lines, subtotal: Money.add(...lines.map((l) => l.fare), 0) };
  });

  const fareTotal = Money.add(...segmentQuotes.map((s) => s.subtotal), 0);
  const promoResult = promo ? validatePromo(promo, { paxCount: passengers.length, isReturn }) : null;
  const discount = promoResult?.ok ? -Money.round(Money.pct(fareTotal, promoResult.promo.discountPct)) : 0;

  const extras = [];
  if (ancillaries.extraBag > 0) extras.push({ code: "BAG", label: `${ANCILLARIES.extraBag.label} × ${ancillaries.extraBag}`, amount: ANCILLARIES.extraBag.unit * ancillaries.extraBag });
  if (ancillaries.insurance) extras.push({ code: "INS", label: `${ANCILLARIES.insurance.label} × ${passengers.length}`, amount: ANCILLARIES.insurance.unit * passengers.length });
  if (ancillaries.flexible) extras.push({ code: "FLEX", label: ANCILLARIES.flexible.label, amount: Money.round(Money.pct(fareTotal + discount, ANCILLARIES.flexible.pctOfFare)) });

  const extrasTotal = Money.add(...extras.map((e) => e.amount), 0);
  const serviceFee = SERVICE_FEE_PER_PAX * passengers.length * segments.length;
  const taxable = fareTotal + discount + extrasTotal + serviceFee;
  const vat = Money.pct(taxable, VAT_RATE);

  return {
    currency: BASE_CURRENCY, isReturn, segmentQuotes,
    promo: promoResult?.ok ? promoResult.promo : null, flexible: !!ancillaries.flexible,
    breakdown: [
      { code: "FARE", label: isReturn ? "Base fare (both directions)" : "Base fare", amount: fareTotal },
      ...(discount ? [{ code: "DISC", label: `Promotion ${promoResult.promo.code}`, amount: discount }] : []),
      ...extras,
      { code: "YQ", label: "Booking service fee", amount: serviceFee },
      { code: "VAT", label: `VAT (${VAT_RATE}%)`, amount: vat },
    ],
    total: taxable + vat,
  };
}

export const REFUND_RULES = [
  { minHoursBefore: 48, refundPct: 90, label: "48 hours or more before departure" },
  { minHoursBefore: 24, refundPct: 70, label: "24–48 hours before departure" },
  { minHoursBefore: 4, refundPct: 40, label: "4–24 hours before departure" },
  { minHoursBefore: 0, refundPct: 0, label: "Less than 4 hours before departure" },
];

export function refundQuote(booking, now = Date.now()) {
  const hours = (new Date(booking.segments[0].service.departISO).getTime() - now) / 3600000;
  const rule = booking.quote.flexible
    ? { minHoursBefore: 0, refundPct: 100, label: "Flexible fare — fully refundable up to departure" }
    : REFUND_RULES.find((r) => hours >= r.minHoursBefore) || REFUND_RULES[REFUND_RULES.length - 1];
  const nonRefundable = SERVICE_FEE_PER_PAX * booking.passengers.length * booking.segments.length;
  return { rule, hours, amount: Money.round(Money.pct(Math.max(booking.quote.total - nonRefundable, 0), rule.refundPct)) };
}
