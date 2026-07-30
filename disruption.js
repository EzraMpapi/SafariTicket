/**
 * Delay and cancellation as first-class states.
 *
 * The compensation table is data: the same object is published to passengers,
 * printed on the ticket and evaluated by the engine, so the stated policy and
 * the enforced policy cannot drift apart.
 */
import { Money } from "./money.js";
import { addMinutesISO, addDaysISO } from "./time.js";
import { searchServices } from "./inventory.js";

export const DISRUPTION_POLICY = [
  { code: "CANCELLED", minDelayMin: Infinity, compensationPct: 100, rebook: true, label: "Service cancelled" },
  { code: "MAJOR", minDelayMin: 180, compensationPct: 50, rebook: true, label: "Delayed 3 hours or more" },
  { code: "MODERATE", minDelayMin: 90, compensationPct: 25, rebook: true, label: "Delayed 90 minutes or more" },
  { code: "MINOR", minDelayMin: 30, compensationPct: 10, rebook: false, label: "Delayed 30 minutes or more" },
  { code: "ONTIME", minDelayMin: 0, compensationPct: 0, rebook: false, label: "Running to time" },
];

/** @param disruption {{kind:'DELAY'|'CANCEL', delayMin:number, reason:string}} */
export function disruptionOutcome(disruption, booking) {
  if (!disruption) return null;
  const rule = disruption.kind === "CANCEL"
    ? DISRUPTION_POLICY[0]
    : DISRUPTION_POLICY.find((r) => r.code !== "CANCELLED" && disruption.delayMin >= r.minDelayMin);
  const fareOnly = booking.quote.breakdown.find((b) => b.code === "FARE")?.amount ?? 0;
  return {
    rule, disruption,
    compensation: Money.round(Money.pct(fareOnly, rule.compensationPct)),
    rebookOffered: rule.rebook,
    revisedDeparture: disruption.kind === "CANCEL" ? null
      : addMinutesISO(booking.segments[0].service.departISO, disruption.delayMin),
  };
}

/** Alternatives on the same route, later the same day, with room for the party. */
export function rebookingOptions(booking, disruption) {
  const seg = booking.segments[0].service;
  const sameDay = searchServices({ from: seg.from, to: seg.to, date: seg.departISO.slice(0, 10) })
    .filter((s) => s.id !== seg.id && s.seatsAvailable >= booking.passengers.length);
  const nextDay = searchServices({ from: seg.from, to: seg.to, date: addDaysISO(seg.departISO.slice(0, 10), 1) })
    .filter((s) => s.seatsAvailable >= booking.passengers.length);
  const cutoff = disruption?.kind === "CANCEL" ? seg.departISO : addMinutesISO(seg.departISO, disruption?.delayMin ?? 0);
  return [...sameDay.filter((s) => s.departISO >= seg.departISO && s.departISO <= cutoff || s.departISO > seg.departISO), ...nextDay]
    .slice(0, 4);
}
