/**
 * All timestamps are ISO 8601 with an explicit +03:00 offset. East Africa Time
 * has no DST, so a fixed offset is correct rather than a shortcut.
 */
import { TZ_OFFSET } from "./catalog.js";

export const todayISO = () => new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
export const localTime = (iso) => iso.slice(11, 16);
export const hourOf = (iso) => Number(iso.slice(11, 13));

export function addMinutesISO(iso, minutes) {
  const shifted = new Date(new Date(iso).getTime() + minutes * 60000 + 3 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${p(shifted.getUTCMonth() + 1)}-${p(shifted.getUTCDate())}T${p(shifted.getUTCHours())}:${p(shifted.getUTCMinutes())}:00${TZ_OFFSET}`;
}
export function addDaysISO(dateISO, days) {
  const d = new Date(`${dateISO}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
export const dayOffset = (dep, arr) => (arr.slice(0, 10) === dep.slice(0, 10) ? "" : "+1");

export function formatDate(iso, locale) {
  try {
    return new Date(`${iso}T00:00:00${TZ_OFFSET}`).toLocaleDateString(locale === "sw" ? "sw-TZ" : "en-GB",
      { weekday: "short", day: "2-digit", month: "short" });
  } catch { return iso; }
}
export function formatDuration(min, t) {
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h}${t("h")} ${m}${t("m")}` : `${h}${t("h")}`;
}
export function countdownTo(iso, now = Date.now()) {
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return null;
  const d = Math.floor(ms / 86400000), h = Math.floor((ms % 86400000) / 3600000), m = Math.floor((ms % 3600000) / 60000);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}
