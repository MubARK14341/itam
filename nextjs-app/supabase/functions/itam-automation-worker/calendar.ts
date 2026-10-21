const RIYADH_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function shifted(date: Date): Date {
  return new Date(date.getTime() + RIYADH_OFFSET_MS);
}

export interface RiyadhParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
  dateKey: string;
}

export function riyadhParts(date: Date): RiyadhParts {
  const local = shifted(date);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth() + 1;
  const day = local.getUTCDate();
  return {
    year,
    month,
    day,
    hour: local.getUTCHours(),
    minute: local.getUTCMinutes(),
    weekday: local.getUTCDay(),
    dateKey: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  };
}

export function isBusinessWeekday(weekday: number): boolean {
  return weekday !== 5 && weekday !== 6;
}

export function elapsedWeekdayMinutesBetween(start: Date, end: Date): number {
  if (!(start instanceof Date) || !(end instanceof Date) || !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) return 0;
  const shiftedStart = start.getTime() + RIYADH_OFFSET_MS;
  const shiftedEnd = end.getTime() + RIYADH_OFFSET_MS;
  let cursor = Math.floor(shiftedStart / DAY_MS) * DAY_MS;
  let minutes = 0;
  while (cursor < shiftedEnd) {
    const dayEnd = cursor + DAY_MS;
    const weekday = new Date(cursor).getUTCDay();
    if (isBusinessWeekday(weekday)) {
      const overlap = Math.max(0, Math.min(shiftedEnd, dayEnd) - Math.max(shiftedStart, cursor));
      minutes += Math.floor(overlap / 60_000);
    }
    cursor = dayEnd;
  }
  return minutes;
}

export function businessDaysBetween(start: Date, end: Date): number {
  return elapsedWeekdayMinutesBetween(start, end) / (24 * 60);
}

export function dateKeyInRiyadh(date: Date): string {
  return riyadhParts(date).dateKey;
}

export function calendarDaysUntil(targetDate: string, now: Date): number {
  const [year, month, day] = targetDate.split("-").map(Number);
  if (!year || !month || !day) return Number.NaN;
  const targetLocalMidnight = Date.UTC(year, month - 1, day);
  const p = riyadhParts(now);
  const todayLocalMidnight = Date.UTC(p.year, p.month - 1, p.day);
  return Math.round((targetLocalMidnight - todayLocalMidnight) / DAY_MS);
}

export function firstBusinessDayOfMonth(date: Date): boolean {
  const p = riyadhParts(date);
  for (let day = 1; day < p.day; day += 1) {
    const weekday = new Date(Date.UTC(p.year, p.month - 1, day)).getUTCDay();
    if (isBusinessWeekday(weekday)) return false;
  }
  return isBusinessWeekday(p.weekday);
}

export function scannerSchedule(now: Date): {
  hourly: true;
  morningDigest: boolean;
  endOfDay: boolean;
  weekly: boolean;
  monthly: boolean;
  dateKey: string;
} {
  const p = riyadhParts(now);
  const businessDay = isBusinessWeekday(p.weekday);
  return {
    hourly: true,
    // Asia/Riyadh is UTC+03 with no DST.  The scanner is scheduled hourly in
    // UTC, but the business rule is deliberately expressed in Riyadh parts so
    // that the 09:00 requirement cannot silently drift into a UTC assumption.
    morningDigest: businessDay && p.hour === 9,
    endOfDay: businessDay && p.hour === 17,
    weekly: p.weekday === 0 && p.hour === 8,
    monthly: firstBusinessDayOfMonth(now) && p.hour === 8,
    dateKey: p.dateKey,
  };
}
