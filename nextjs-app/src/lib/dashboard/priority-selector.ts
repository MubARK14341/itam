import type { DashboardPriorityItem, DashboardSeverity, DashboardSlaStatus } from "@/lib/dashboard/dashboard-types";
import { dashboardAgeDays, dateKeyInDashboardTimeZone } from "@/lib/dashboard/dashboard-filters";

const SEVERITY_RANK: Record<Exclude<DashboardSeverity, "success">, number> = {
  critical: 0,
  warning: 1,
  info: 2,
  neutral: 3,
};

const SLA_RANK: Record<DashboardSlaStatus, number> = {
  overdue: 0,
  due_today: 1,
  at_risk: 2,
  on_track: 3,
  not_applicable: 4,
};

function timestamp(value: string | null): number {
  if (!value) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

export function compareDashboardPriority(a: DashboardPriorityItem, b: DashboardPriorityItem): number {
  return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    || b.overdueDays - a.overdueDays
    || SLA_RANK[a.slaStatus] - SLA_RANK[b.slaStatus]
    || timestamp(a.dueAt) - timestamp(b.dueAt)
    || timestamp(a.createdAt) - timestamp(b.createdAt)
    || a.entityId.localeCompare(b.entityId);
}

export function selectDashboardPriorities(
  candidates: DashboardPriorityItem[],
  limit = 6,
): DashboardPriorityItem[] {
  const unique = new Map<string, DashboardPriorityItem>();
  for (const candidate of candidates) {
    const key = `${candidate.entityType}:${candidate.entityId}:${candidate.kind}`;
    if (!unique.has(key)) unique.set(key, candidate);
  }
  return [...unique.values()].sort(compareDashboardPriority).slice(0, Math.max(0, limit));
}

export function dashboardSlaStatus(
  dueAt: string | null,
  now: Date | string | number = new Date(),
): DashboardSlaStatus {
  if (!dueAt) return "not_applicable";
  const today = dateKeyInDashboardTimeZone(now);
  const due = dueAt.slice(0, 10);
  if (!today || !due) return "not_applicable";
  if (due < today) return "overdue";
  if (due === today) return "due_today";
  const dueTime = Date.parse(`${due}T12:00:00.000Z`);
  const todayTime = Date.parse(`${today}T12:00:00.000Z`);
  const daysUntil = Math.ceil((dueTime - todayTime) / 86_400_000);
  return daysUntil <= 2 ? "at_risk" : "on_track";
}
