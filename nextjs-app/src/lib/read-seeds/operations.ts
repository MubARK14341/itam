import "server-only";

// Server read seeds mirror a page's selected first-screen reads (same lib functions and URL/role
// rules). Reports seed only small selected references/RPCs: full datasets stay in the complete,
// abortable browser collectors, avoiding bulky partial seeds followed by repeated report reads.
// A missing seed is harmless; its browser request proceeds through the visitor's normal client.

import type { MaintenanceViewKey, RequestViewKey } from "@/lib/alert-predicates";
import {
  getActionAlertOperationalCounts,
  listActionAlertsPage,
  resolveUserLabels as resolveAlertUserLabels,
} from "@/lib/action-center";
import { dateKeyInTimeZone } from "@/lib/format";
import { maintenanceStateFromSearch } from "@/lib/maintenance-navigation";
import type { ReportTab } from "@/lib/report-layout";
import { reportLoadPlan } from "@/lib/report-load-plan";
import {
  getActivity,
  getMaintenanceOperationalSummary,
  getReportData,
  listDepreciationRules,
  listAssetsPage,
  listConsumablesPage,
  listMaintenancePage,
  listRegistrationRequests,
  listUnsoundReturnedAssets,
} from "@/lib/queries";
import { requestQueueStateFromSearch } from "@/lib/request-navigation";
import { REQUEST_STAGE_STATUSES, isRequestStageKey } from "@/lib/request-stages";
import {
  getRequestFilterOptions,
  getRequestOperationalCounts,
  listRequestsPage,
  resolveUserLabels,
} from "@/lib/requests";
import { canManageSettings, canSeeFinancial } from "@/lib/staff-access";
import { createClient } from "@/lib/supabase/client";
import { collectReadSeed } from "@/lib/supabase/server-read-seed";
import { WAREHOUSE_REQUEST_STATUSES } from "@/lib/warehouse-buckets";
import { canAccessInternalPath } from "@/lib/user-facing-role";
import { handedOffContext, searchString, type PageSearchParams } from "@/lib/read-seeds/context";

async function staffRole() {
  return (await handedOffContext())?.session?.role ?? null;
}

const includeAuditFor = (role: string) => role === "admin" || role === "it_manager";

export async function activityReadSeed() {
  const role = await staffRole();
  if (!role) return null;
  return collectReadSeed(() => getActivity({ includeAudit: includeAuditFor(role) }));
}

export async function requestsReadSeed(searchParams: PageSearchParams) {
  const role = await staffRole();
  if (!role) return null;
  const parsed = requestQueueStateFromSearch(await searchString(searchParams));
  const fin = canSeeFinancial(role);
  const warehouseMode = parsed.view === "warehouse" || role === "technician" || role === "warehouse_manager";
  const view = parsed.view && parsed.view !== "warehouse" ? parsed.view as RequestViewKey : null;
  const todayISO = dateKeyInTimeZone();
  const userId = (await handedOffContext())?.session?.userId;
  return collectReadSeed(() => Promise.all([
    (async () => {
      if (parsed.responsible === "__mine" && !userId) return;
      const page = await listRequestsPage({
        cursor: null,
        ascending: warehouseMode,
        includeFinancial: fin,
        filters: {
          q: parsed.q,
          status: parsed.status,
          city: parsed.city,
          party: parsed.source as "portal" | "customer" | "employee" | "",
          customerId: parsed.customer,
          responsibleId: parsed.responsible === "__mine" ? userId : parsed.responsible || undefined,
          overdueOnly: parsed.overdueOnly,
          view,
          todayISO,
          statuses: warehouseMode
            ? WAREHOUSE_REQUEST_STATUSES
            : isRequestStageKey(parsed.stage) ? [...REQUEST_STAGE_STATUSES[parsed.stage]] : undefined,
        },
      });
      const ids = page.rows.map((r) => r.responsible_employee_id).filter((x): x is string => !!x);
      if (ids.length) await resolveUserLabels(ids);
    })(),
    (async () => {
      const [, optionsResult] = await Promise.all([getRequestOperationalCounts(), getRequestFilterOptions()]);
      const ids = optionsResult.options?.responsible_ids ?? [];
      if (ids.length) await resolveUserLabels(ids);
    })(),
    warehouseMode
      ? listRequestsPage({ pageSize: 20, includeFinancial: fin, filters: { q: parsed.q, statuses: ["completed"] } })
      : null,
  ]));
}

export async function alertsReadSeed() {
  const role = await staffRole();
  if (!role) return null;
  return collectReadSeed(() => Promise.all([
    (async () => {
      const page = await listActionAlertsPage({
        cursor: null,
        filters: { tab: "needsAction", type: "", severity: "", assignedTo: null },
      });
      await Promise.all([
        resolveAlertUserLabels(page.rows.map((r) => r.assigned_to).filter(Boolean) as string[]),
        getActionAlertOperationalCounts(),
      ]);
    })(),
    canManageSettings(role) ? listRegistrationRequests("approved") : null,
    listUnsoundReturnedAssets(),
  ]));
}

export async function maintenanceReadSeed(searchParams: PageSearchParams, nowMs = Date.now()) {
  const role = await staffRole();
  if (!role) return null;
  const parsed = maintenanceStateFromSearch(await searchString(searchParams));
  const userId = (await handedOffContext())?.session?.userId;
  return collectReadSeed(() => Promise.all([
    parsed.mineOnly && !userId ? null : listMaintenancePage({
      cursor: null,
      includeFinancial: canSeeFinancial(role),
      filters: {
        q: parsed.q,
        status: parsed.status,
        type: parsed.type,
        problemType: parsed.problemType,
        view: (parsed.view || null) as MaintenanceViewKey | null,
        todayISO: dateKeyInTimeZone(new Date(nowMs)),
        longBeforeISO: new Date(nowMs - 14 * 86_400_000).toISOString(),
        technicianId: parsed.mineOnly ? userId : undefined,
      },
    }),
    getMaintenanceOperationalSummary(),
  ]));
}

// Only the default inventory document seeds its two identical first-page reads.
// Query-specific views retain their ordinary browser reads; filter references stay there too.
// Slow optional reads stop after 100 ms; complete entries still replay and missing reads fall back.
export async function assetsReadSeed(searchParams: PageSearchParams) {
  if (await searchString(searchParams)) return null;
  const session = (await handedOffContext())?.session;
  if (!session || session.approvalStatus !== "approved"
    || typeof session.userId !== "string" || !session.userId
    || !canAccessInternalPath(session.role, "/assets")) return null;
  return collectReadSeed(() => Promise.all([
    listAssetsPage({ cursor: null }),
    listConsumablesPage({ cursor: null, includeFinancial: false }),
  ]), { budgetMs: 100 });
}

export async function reportsReadSeed(tab: ReportTab) {
  // These documents leave optional references/RPCs to their complete, scoped browser loaders.
  if (tab === "inventory" || tab === "executive") return null;
  const plan = reportLoadPlan(tab);
  const references = plan.datasets.includes("references");
  if (!references && !plan.decisionCounts && !plan.depreciationRules && !plan.financialQuality) return null;
  const role = await staffRole();
  if (!role) return null;
  const fin = canSeeFinancial(role);
  return collectReadSeed(() => Promise.all([
    references ? getReportData(fin && tab !== "custody", { datasets: ["references"], assetProjection: plan.assetProjection }) : null,
    plan.decisionCounts ? getActionAlertOperationalCounts() : null,
    fin && plan.depreciationRules ? listDepreciationRules(true, { strictFinancial: true }) : null,
    // The browser reads the 200-row queue; only its identical summary RPC belongs in the seed.
    fin && plan.financialQuality ? createClient().rpc("financial_data_quality_summary") : null,
  ]));
}
