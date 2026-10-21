export const REQUEST_DATE_MAX_YEARS = 10;
const PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const leap = (year: number) => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
const days = (year: number, month: number) => [31, leap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
export function isStrictRequestDate(value: string) { if (!PATTERN.test(value)) return false; const y=+value.slice(0,4), m=+value.slice(5,7), d=+value.slice(8,10); return y > 0 && d <= days(y,m); }
export function requestDateMaximum(today: string) { if (!isStrictRequestDate(today)) throw new Error("invalid_today"); const y=+today.slice(0,4)+REQUEST_DATE_MAX_YEARS, m=+today.slice(5,7), d=Math.min(+today.slice(8,10),days(y,m)); return `${y}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}`; }
export function isSupportedRequestDate(value: string, today: string) { return isStrictRequestDate(value) && value >= today && value <= requestDateMaximum(today); }

/** Application calendar day, deliberately formatted without locale-dependent coercion. */
export function riyadhTodayISO(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Riyadh", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const value = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}
