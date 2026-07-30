/** E.164 phone numbers, ISO 3166 nationalities, field-level error messages. */

export const COUNTRIES = [
  { code: "TZ", name: "Tanzania", dial: "+255" }, { code: "KE", name: "Kenya", dial: "+254" },
  { code: "UG", name: "Uganda", dial: "+256" }, { code: "RW", name: "Rwanda", dial: "+250" },
  { code: "BI", name: "Burundi", dial: "+257" }, { code: "ZM", name: "Zambia", dial: "+260" },
  { code: "MW", name: "Malawi", dial: "+265" }, { code: "GB", name: "United Kingdom", dial: "+44" },
  { code: "US", name: "United States", dial: "+1" }, { code: "DE", name: "Germany", dial: "+49" },
];

export function toE164(input, dial = "+255") {
  const digits = String(input || "").replace(/[^\d+]/g, "");
  return digits.startsWith("+") ? digits : `${dial}${digits.replace(/^0+/, "")}`;
}
export const isValidE164 = (v) => /^\+[1-9]\d{7,14}$/.test(v);
export const isValidEmail = (v) => !v || /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
export const isValidName = (v) => /^[\p{L}\p{M}\s'.-]{2,}$/u.test(String(v || "").trim());

export function validatePassenger(p) {
  const e = {};
  if (!isValidName(p.firstName)) e.firstName = "Enter the given name as printed on the ID.";
  if (!isValidName(p.lastName)) e.lastName = "Enter the surname as printed on the ID.";
  if (!p.documentNumber || p.documentNumber.trim().length < 5) e.documentNumber = "At least 5 characters.";
  return e;
}
export function validateContact(c) {
  const e = {};
  if (!isValidE164(toE164(c.phone, c.dial))) e.phone = "Enter a reachable mobile number, e.g. 0712 345 678.";
  if (!isValidEmail(c.email)) e.email = "Check the email format.";
  return e;
}

export const passengerComplete = (p) => Object.keys(validatePassenger(p)).length === 0;
