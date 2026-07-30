/** Shared fixtures. A test keyring — never the production one. */
import { computeTag, searchServices, todayISO, issueTicketNumber } from "../src/index.js";

export const TEST_KEYRING = { T1: "test-key-one", T2: "test-key-two" };
export const ACTIVE = "T2";

export const testSigner = (keyId = ACTIVE) => (message) => ({
  keyId,
  tag: computeTag(TEST_KEYRING[keyId], message),
});

export function firstService(from = "DAR", to = "ARK", date = todayISO()) {
  const s = searchServices({ from, to, date });
  if (!s.length) throw new Error(`no services for ${from}-${to}`);
  return s[0];
}

export function makeBooking({ locator = "AAAAA2", service, seats = [5], names = [["Asha", "Mbwana"]] } = {}) {
  const svc = service ?? firstService();
  return {
    locator,
    status: "CONFIRMED",
    passengers: names.map(([firstName, lastName]) => ({
      firstName, lastName, type: "ADT", documentType: "NID", documentNumber: "19900101234",
    })),
    segments: [{ service: svc, seats }],
    tickets: names.map((_, i) => issueTicketNumber("401", i)),
    contact: { phoneE164: "+255712345678" },
    quote: { total: 100000, flexible: false, breakdown: [{ code: "FARE", amount: 80000 }] },
  };
}

export const insideWindow = (service) => new Date(service.departISO).getTime() - 40 * 60000;
