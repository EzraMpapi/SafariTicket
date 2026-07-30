/**
 * Money is an integer in the base currency's minor unit. No float arithmetic
 * reaches a fare, and every division is wrapped in an explicit rounding rule.
 */

export const BASE_CURRENCY = "TZS";
export const FX = {
  TZS: { rate: 1, minorUnits: 0, locale: "en-TZ" },
  USD: { rate: 1 / 2600, minorUnits: 2, locale: "en-US" },
  EUR: { rate: 1 / 2820, minorUnits: 2, locale: "de-DE" },
  KES: { rate: 1 / 20.1, minorUnits: 0, locale: "en-KE" },
};
export const Money = {
  add: (...xs) => xs.reduce((a, b) => a + b, 0),
  pct: (amount, percent) => Math.round((amount * percent) / 100),
  round: (amount) => Math.round(amount / 100) * 100,
  format(amountTZS, currency = BASE_CURRENCY) {
    const spec = FX[currency] || FX[BASE_CURRENCY];
    try {
      return new Intl.NumberFormat(spec.locale, {
        style: "currency", currency,
        minimumFractionDigits: spec.minorUnits, maximumFractionDigits: spec.minorUnits,
      }).format(amountTZS * spec.rate);
    } catch { return `${currency} ${(amountTZS * spec.rate).toFixed(spec.minorUnits)}`; }
  },
};
