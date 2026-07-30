/**
 * Fiscal receipts.
 *
 * Tanzanian electronic fiscal receipts carry a receipt number, a Z (daily
 * closure) number and a verification code the buyer can check with the revenue
 * authority. Derived deterministically so a reprint matches the original.
 *
 * Note: these values are computed locally. A production deployment must obtain
 * them from the TRA VFD service — a self-generated receipt number is not a
 * fiscal receipt, it only has the shape of one.
 */

import { seedFrom } from "./documents.js";

export const MERCHANT = { name: "SafariTiketi Ltd", tin: "142-873-905", vrn: "40-091822-C" };

export function issueFiscalReceipt(locator, totalTZS, issuedAt) {
  const seed = seedFrom(`${locator}${totalTZS}${issuedAt}`);
  return {
    receiptNo: `${issuedAt.slice(0, 10).replace(/-/g, "")}-${String(seed % 100000).padStart(5, "0")}`,
    zNumber: String(1000 + (seed % 9000)),
    verificationCode: String(seed % 1_000_000_000_000).padStart(12, "0").replace(/(\d{4})(?=\d)/g, "$1 "),
    verifyUrl: "https://verify.tra.go.tz", ...MERCHANT,
  };
}
