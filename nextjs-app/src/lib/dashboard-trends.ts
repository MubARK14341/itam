const RIYADH_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

export const DASHBOARD_TREND_MAX_ROWS = 1000;
export const DASHBOARD_TREND_PAGE_SIZE = 500;

export interface MaintenanceTrendRow {
  id: string;
  reported_at: string | null;
  completed_at: string | null;
  status: string;
}

export interface MaintenanceWeekBucket {
  key: string;
  start: string;
  reported: number;
  completed: number;
}

export interface ConsumableRiskInput {
  id: string;
  name: string;
  quantity_on_hand: number | string | null;
  reorder_level: number | string | null;
}

export interface ConsumableRiskRow {
  id: string;
  name: string;
  quantity: number;
  threshold: number;
  ratio: number;
  ratioPercent: number;
}

export function startOfRiyadhWeek(value: Date | string | number): Date {
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) throw new RangeError("invalid_date");

  // الرياض لا تطبق التوقيت الصيفي؛ نحول اللحظة إلى تقويم محلي ثم نرجع منتصف
  // ليل الأحد كـ UTC. هذا يمنع انزياح السجلات قرب منتصف الليل.
  const local = new Date(instant.getTime() + RIYADH_OFFSET_MS);
  const localMidnightUtc = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate(),
  );
  const weekday = new Date(localMidnightUtc).getUTCDay();
  return new Date(localMidnightUtc - weekday * DAY_MS - RIYADH_OFFSET_MS);
}

export function maintenanceTrendSince(now: Date | string | number = new Date()): string {
  return new Date(startOfRiyadhWeek(now).getTime() - 11 * WEEK_MS).toISOString();
}

export function canFetchExactTrend(...counts: number[]): boolean {
  return counts.every((count) => Number.isInteger(count) && count >= 0 && count <= DASHBOARD_TREND_MAX_ROWS);
}

export function buildPageRanges(count: number, pageSize = DASHBOARD_TREND_PAGE_SIZE): Array<[number, number]> {
  if (!Number.isInteger(count) || count <= 0 || !Number.isInteger(pageSize) || pageSize <= 0) return [];
  const ranges: Array<[number, number]> = [];
  for (let from = 0; from < count; from += pageSize) {
    ranges.push([from, Math.min(from + pageSize - 1, count - 1)]);
  }
  return ranges;
}

export function dedupeMaintenanceRows(rows: MaintenanceTrendRow[]): MaintenanceTrendRow[] {
  const byId = new Map<string, MaintenanceTrendRow>();
  for (const row of rows) {
    if (!row?.id) continue;
    const current = byId.get(row.id);
    byId.set(row.id, current ? {
      id: row.id,
      reported_at: current.reported_at ?? row.reported_at,
      completed_at: current.completed_at ?? row.completed_at,
      status: row.status || current.status,
    } : row);
  }
  return Array.from(byId.values());
}

export function median(values: number[]): number | null {
  const valid = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (valid.length === 0) return null;
  const middle = Math.floor(valid.length / 2);
  return valid.length % 2 === 1 ? valid[middle] : (valid[middle - 1] + valid[middle]) / 2;
}

export function buildMaintenanceTrend(
  inputRows: MaintenanceTrendRow[],
  now: Date | string | number = new Date(),
): { weeks: MaintenanceWeekBucket[]; medianCloseDays: number | null } {
  const currentWeek = startOfRiyadhWeek(now);
  const firstWeekMs = currentWeek.getTime() - 11 * WEEK_MS;
  const endExclusiveMs = currentWeek.getTime() + WEEK_MS;
  const weeks: MaintenanceWeekBucket[] = Array.from({ length: 12 }, (_, index) => {
    const start = new Date(firstWeekMs + index * WEEK_MS).toISOString();
    return { key: start.slice(0, 10), start, reported: 0, completed: 0 };
  });

  const durations: number[] = [];
  for (const row of dedupeMaintenanceRows(inputRows)) {
    const reportedMs = row.reported_at ? Date.parse(row.reported_at) : Number.NaN;
    if (Number.isFinite(reportedMs) && reportedMs >= firstWeekMs && reportedMs < endExclusiveMs) {
      const index = Math.floor((startOfRiyadhWeek(reportedMs).getTime() - firstWeekMs) / WEEK_MS);
      if (weeks[index]) weeks[index].reported++;
    }

    const completedMs = row.completed_at ? Date.parse(row.completed_at) : Number.NaN;
    if (row.status !== "completed" || !Number.isFinite(completedMs)) continue;
    if (completedMs >= firstWeekMs && completedMs < endExclusiveMs) {
      const index = Math.floor((startOfRiyadhWeek(completedMs).getTime() - firstWeekMs) / WEEK_MS);
      if (weeks[index]) weeks[index].completed++;
    }
    if (Number.isFinite(reportedMs) && completedMs >= reportedMs) {
      durations.push((completedMs - reportedMs) / DAY_MS);
    }
  }

  const medianDays = median(durations);
  return {
    weeks,
    medianCloseDays: medianDays == null ? null : Math.round(medianDays * 10) / 10,
  };
}

export function buildConsumableRisk(rows: ConsumableRiskInput[]): {
  rows: ConsumableRiskRow[];
  totalAtRisk: number;
  withoutThreshold: number;
} {
  let withoutThreshold = 0;
  const atRisk: ConsumableRiskRow[] = [];

  for (const row of rows) {
    const quantity = Number(row.quantity_on_hand);
    const threshold = Number(row.reorder_level);
    if (!Number.isFinite(threshold) || threshold <= 0) {
      withoutThreshold++;
      continue;
    }
    if (!Number.isFinite(quantity) || quantity < 0) continue;
    const ratio = quantity / threshold;
    if (ratio > 1) continue;
    atRisk.push({
      id: row.id,
      name: row.name,
      quantity,
      threshold,
      ratio,
      ratioPercent: Math.round(ratio * 100),
    });
  }

  atRisk.sort((a, b) => a.ratio - b.ratio || a.name.localeCompare(b.name));
  return { rows: atRisk.slice(0, 5), totalAtRisk: atRisk.length, withoutThreshold };
}
