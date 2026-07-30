import { test } from "node:test";
import assert from "node:assert/strict";
import { disruptionOutcome, rebookingOptions, DISRUPTION_POLICY } from "../src/index.js";
import { firstService } from "./helpers.js";

const bookingWithFare = (amount, service) => ({
  quote: { breakdown: [{ code: "FARE", amount }] },
  segments: [{ service, seats: [1] }],
  passengers: [{}],
});

test("compensation rises with the length of the delay", () => {
  const b = bookingWithFare(100000, firstService());
  const pcts = [20, 45, 100, 200].map((delayMin) => disruptionOutcome({ kind: "DELAY", delayMin }, b).rule.compensationPct);
  for (let i = 1; i < pcts.length; i++) assert.ok(pcts[i] >= pcts[i - 1], `${pcts}`);
});

test("a short delay carries no entitlement", () => {
  const o = disruptionOutcome({ kind: "DELAY", delayMin: 10 }, bookingWithFare(90000, firstService()));
  assert.equal(o.compensation, 0);
  assert.equal(o.rebookOffered, false);
});

test("cancellation entitles a full fare refund and a rebooking", () => {
  const o = disruptionOutcome({ kind: "CANCEL" }, bookingWithFare(90000, firstService()));
  assert.equal(o.compensation, 90000);
  assert.equal(o.rebookOffered, true);
  assert.equal(o.revisedDeparture, null);
});

test("compensation never exceeds the fare", () => {
  const b = bookingWithFare(75000, firstService());
  for (const d of [{ kind: "DELAY", delayMin: 600 }, { kind: "CANCEL" }]) {
    assert.ok(disruptionOutcome(d, b).compensation <= 75000);
  }
});

test("a delay produces a revised departure time", () => {
  const svc = firstService();
  const o = disruptionOutcome({ kind: "DELAY", delayMin: 90 }, bookingWithFare(50000, svc));
  assert.ok(o.revisedDeparture);
  assert.notEqual(o.revisedDeparture, svc.departISO);
});

test("rebooking never offers the disrupted service back", () => {
  const svc = firstService();
  const b = bookingWithFare(50000, svc);
  for (const o of rebookingOptions(b, { kind: "CANCEL" })) assert.notEqual(o.id, svc.id);
});

test("rebooking only offers coaches with room for the whole party", () => {
  const svc = firstService();
  const b = { segments: [{ service: svc, seats: [1, 2, 3] }], passengers: [{}, {}, {}], quote: { breakdown: [{ code: "FARE", amount: 1 }] } };
  for (const o of rebookingOptions(b, { kind: "CANCEL" })) assert.ok(o.seatsAvailable >= 3);
});

test("the policy table is ordered from most to least severe", () => {
  const pcts = DISRUPTION_POLICY.map((r) => r.compensationPct);
  for (let i = 1; i < pcts.length; i++) assert.ok(pcts[i] <= pcts[i - 1]);
});
