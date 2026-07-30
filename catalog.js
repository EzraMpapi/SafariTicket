/**
 * Reference data: stations, carriers, cabin classes.
 *
 * In production this is served from the operator catalogue with an ETag; the
 * shape below is the contract that must be preserved.
 */

export const TZ_OFFSET = "+03:00";

export const STATIONS = [
  { code: "DAR", name: "Dar es Salaam", terminal: "Magufuli Bus Terminal, Mbezi", lat: -6.79, lon: 39.21 },
  { code: "ARK", name: "Arusha", terminal: "Arusha Central Bus Stand", lat: -3.37, lon: 36.68 },
  { code: "MOS", name: "Moshi", terminal: "Moshi Bus Terminal", lat: -3.35, lon: 37.34 },
  { code: "DOD", name: "Dodoma", terminal: "Nanenane Bus Stand", lat: -6.17, lon: 35.74 },
  { code: "MWZ", name: "Mwanza", terminal: "Nyegezi Bus Terminal", lat: -2.52, lon: 32.90 },
  { code: "MBI", name: "Mbeya", terminal: "Mbeya Bus Terminal", lat: -8.90, lon: 33.46 },
  { code: "MOG", name: "Morogoro", terminal: "Msamvu Bus Stand", lat: -6.82, lon: 37.66 },
  { code: "IRI", name: "Iringa", terminal: "Ipogolo Bus Stand", lat: -7.77, lon: 35.69 },
  { code: "TGT", name: "Tanga", terminal: "Tanga Bus Terminal", lat: -5.07, lon: 39.10 },
  { code: "SGX", name: "Songea", terminal: "Songea Bus Stand", lat: -10.68, lon: 35.65 },
  { code: "MUZ", name: "Musoma", terminal: "Musoma Bus Stand", lat: -1.50, lon: 33.80 },
  { code: "SGD", name: "Singida", terminal: "Singida Bus Stand", lat: -4.82, lon: 34.75 },
  { code: "BBT", name: "Babati", terminal: "Babati Bus Stand", lat: -4.22, lon: 35.75 },
  { code: "TBO", name: "Tabora", terminal: "Tabora Bus Stand", lat: -5.02, lon: 32.83 },
  { code: "TKQ", name: "Kigoma", terminal: "Kigoma Bus Terminal", lat: -4.88, lon: 29.63 },
  { code: "SUT", name: "Sumbawanga", terminal: "Sumbawanga Bus Stand", lat: -7.97, lon: 31.62 },
  { code: "NJO", name: "Njombe", terminal: "Njombe Bus Stand", lat: -9.34, lon: 34.77 },
  { code: "BKZ", name: "Bukoba", terminal: "Bukoba Bus Stand", lat: -1.33, lon: 31.81 },
  { code: "SHY", name: "Shinyanga", terminal: "Shinyanga Bus Stand", lat: -3.66, lon: 33.42 },
  { code: "GIT", name: "Geita", terminal: "Geita Bus Stand", lat: -2.87, lon: 32.23 },
];
export const stationBy = (code) => STATIONS.find((s) => s.code === code);

export function roadDistanceKm(a, b) {
  const R = 6371, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)) * 1.28);
}

/* ─── domain/carriers ────────────────────────────────────────────────────── */

export const CARRIERS = [
  { code: "KR", numeric: "401", name: "Kilambo Royal Coach", cabin: "EXEC", onTime: 94 },
  { code: "AR", numeric: "412", name: "Asante Rabi Express", cabin: "LUX", onTime: 91 },
  { code: "MI", numeric: "425", name: "Machame Investment", cabin: "SEMI", onTime: 87 },
  { code: "BL", numeric: "433", name: "Bright Line", cabin: "LUX", onTime: 90 },
  { code: "PL", numeric: "447", name: "Premier Line", cabin: "EXEC", onTime: 95 },
  { code: "DX", numeric: "452", name: "Dar Express", cabin: "SEMI", onTime: 88 },
  { code: "SD", numeric: "468", name: "Superdoll Express", cabin: "LUX", onTime: 92 },
  { code: "CE", numeric: "474", name: "Champion Express", cabin: "SEMI", onTime: 85 },
  { code: "MT", numeric: "486", name: "Mtei Coach", cabin: "EXEC", onTime: 93 },
  { code: "RE", numeric: "495", name: "Rungwe Express", cabin: "LUX", onTime: 89 },
];

export const CABINS = {
  SEMI: { label: "Semi Luxury", fareBasis: "YSEMI", ratePerKm: 3800, seatPitch: "78 cm", accent: "#3D6E8C", amenities: ["ac", "charge"], baggageKg: 20 },
  LUX: { label: "Luxury", fareBasis: "WLUX", ratePerKm: 5600, seatPitch: "88 cm", accent: "#0E7A5F", amenities: ["ac", "charge", "wifi"], baggageKg: 25 },
  EXEC: { label: "Executive", fareBasis: "JEXEC", ratePerKm: 8200, seatPitch: "104 cm", accent: "#1B4FD8", amenities: ["ac", "charge", "wifi", "tv"], baggageKg: 30 },
};
