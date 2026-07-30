import { test } from "node:test";
import assert from "node:assert/strict";
import {
  quoteItinerary, refundQuote, validatePromo, baseFareFor, REFUND_RULES,
  searchServices, todayISO, addDaysISO, Money,
} from "../src/index.js";
import { firstService } from "./helpers.js";

const sum = (q) => q.breakdown.reduce((a, b) => a + b.amount, 0);

test("the breakdown sums exactly to the total", () => {
  const q = quoteItinerary({
    segments: [{ service: firstService(), seats: [5, 6] }],
    passengers: [{ type: "ADT" }, { type: "CHD" }],
    ancillaries: { extraBag: 2, insurance: true, flexible: true },
    promo: "SAFARI10",
  });
  assert.equal(sum(q), q.total);
});

test("the breakdown sums to the total under maximum load", () => {
  const out = firstService("MOS", "MBI");
  const back = searchServices({ from: "MBI", to: "MOS", date: addDaysISO(todayISO(), 4) })[0];
  const q = quoteItinerary({
    segments: [{ service: out, seats: [1, 2, 3, 4, 5, 6] }, { service: back, seats: [41, 42, 43, 44, 9, 10] }],
    passengers: ["ADT", "CHD", "INF", "SNR", "ADT", "CHD"].map((type) => ({ type })),
    ancillaries: { extraBag: 3, insurance: true, flexible: true },
    promo: "GROUP20",
  });
  assert.equal(sum(q), q.total);
  assert.ok(q.total > 0);
});

test("every money value is an integer", () => {
  const q = quoteItinerary({
    segments: [{ service: firstService("MWZ", "BKZ"), seats: [1] }],
    passengers: [{ type: "SNR" }],
  });
  for (const line of q.breakdown) assert.ok(Number.isInteger(line.amount), `${line.code} is not an integer`);
  assert.ok(Number.isInteger(q.total));
});

test("fares round to the smallest note in circulation", () => {
  for (const svc of searchServices({ from: "DAR", to: "ARK", date: todayISO() })) {
    assert.equal(baseFareFor(svc) % 100, 0);
  }
});

test("VAT applies to the discounted base, not the gross", () => {
  const svc = firstService();
  const plain = quoteItinerary({ segments: [{ service: svc, seats: [20] }], passengers: [{ type: "ADT" }] });
  const promo = quoteItinerary({ segments: [{ service: svc, seats: [20] }], passengers: [{ type: "ADT" }], promo: "SAFARI10" });
  const vatOf = (q) => q.breakdown.find((b) => b.code === "VAT").amount;
  assert.ok(vatOf(promo) < vatOf(plain));
});

test("an unrecognised promotion changes nothing", () => {
  const svc = firstService("DAR", "DOD");
  const args = { segments: [{ service: svc, seats: [8] }], passengers: [{ type: "ADT" }] };
  assert.equal(quoteItinerary(args).total, quoteItinerary({ ...args, promo: "NOTREAL" }).total);
});

test("promotions enforce their own conditions", () => {
  assert.equal(validatePromo("GROUP20", { paxCount: 2, isReturn: false }).ok, false);
  assert.equal(validatePromo("GROUP20", { paxCount: 4, isReturn: false }).ok, true);
  assert.equal(validatePromo("RUDIA15", { paxCount: 1, isReturn: false }).ok, false);
  assert.equal(validatePromo("RUDIA15", { paxCount: 1, isReturn: true }).ok, true);
});

test("the inbound leg is discounted relative to a one-way", () => {
  const out = firstService("DAR", "DOD");
  const back = searchServices({ from: "DOD", to: "DAR", date: addDaysISO(todayISO(), 3) })[0];
  const pax = [{ type: "ADT" }];
  const rt = quoteItinerary({ segments: [{ service: out, seats: [10] }, { service: back, seats: [10] }], passengers: pax });
  const single = quoteItinerary({ segments: [{ service: back, seats: [10] }], passengers: pax });
  assert.ok(rt.segmentQuotes[1].subtotal < single.segmentQuotes[0].subtotal);
});

test("a forward seat costs more than a rear seat", () => {
  const svc = firstService("DAR", "MWZ");
  const front = quoteItinerary({ segments: [{ service: svc, seats: [4] }], passengers: [{ type: "ADT" }] });
  const rear = quoteItinerary({ segments: [{ service: svc, seats: [44] }], passengers: [{ type: "ADT" }] });
  assert.ok(front.total > rear.total);
});

test("infant fares stay above zero", () => {
  const q = quoteItinerary({ segments: [{ service: firstService("DAR", "MOG"), seats: [30] }], passengers: [{ type: "INF" }] });
  assert.ok(q.total > 0);
});

test("refund percentages fall monotonically toward departure", () => {
  const pct = REFUND_RULES.map((r) => r.refundPct);
  for (let i = 1; i < pct.length; i++) assert.ok(pct[i] <= pct[i - 1]);
});

test("a flexible fare refunds in full up to departure", () => {
  const svc = firstService("DAR", "MBI");
  const segments = [{ service: svc, seats: [3] }];
  const passengers = [{ type: "ADT" }];
  const quote = quoteItinerary({ segments, passengers, ancillaries: { flexible: true } });
  const r = refundQuote({ segments, passengers, quote }, new Date(svc.departISO).getTime() - 3600000);
  assert.equal(r.rule.refundPct, 100);
});

test("a refund never exceeds what was paid", () => {
  const svc = firstService();
  const segments = [{ service: svc, seats: [3] }];
  const passengers = [{ type: "ADT" }];
  const quote = quoteItinerary({ segments, passengers });
  for (const hours of [72, 36, 12, 1]) {
    const r = refundQuote({ segments, passengers, quote }, new Date(svc.departISO).getTime() - hours * 3600000);
    assert.ok(r.amount <= quote.total, `${r.amount} exceeds ${quote.total}`);
  }
});

test("Money never emits a fractional shilling", () => {
  for (const v of [1, 33, 12345, 999999]) {
    assert.ok(Number.isInteger(Money.round(v)));
    assert.ok(Number.isInteger(Money.pct(v, 18)));
  }
});
