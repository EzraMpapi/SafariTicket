/** Result filtering. Windows partition the day exactly once — see the tests. */
import { hourOf } from "./time.js";
import { CABINS } from "./catalog.js";

export const DEPARTURE_WINDOWS = [
  { id: "early", label: "Before 09:00", test: (h) => h < 9 },
  { id: "day", label: "09:00 – 16:00", test: (h) => h >= 9 && h < 16 },
  { id: "evening", label: "16:00 – 21:00", test: (h) => h >= 16 && h < 21 },
  { id: "night", label: "After 21:00", test: (h) => h >= 21 },
];
export const EMPTY_FILTERS = { windows: [], cabins: [], carriers: [], amenities: [] };

export function applyFilters(services, f) {
  return services.filter((s) => {
    if (f.windows.length) {
      const h = hourOf(s.departISO);
      if (!f.windows.some((id) => DEPARTURE_WINDOWS.find((w) => w.id === id)?.test(h))) return false;
    }
    if (f.cabins.length && !f.cabins.includes(s.cabinKey)) return false;
    if (f.carriers.length && !f.carriers.includes(s.carrier.code)) return false;
    if (f.amenities.length && !f.amenities.every((a) => s.cabin.amenities.includes(a))) return false;
    return true;
  });
}
export const filterCount = (f) => f.windows.length + f.cabins.length + f.carriers.length + f.amenities.length;
