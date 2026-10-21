import type { FeatureKey } from "./feature-exposure";
import { REPORT_TAB_KEYS, type ReportTab } from "./report-layout";

export type ReportDataset = "assets" | "consumables" | "maintenance" | "references";
export type ReportAssetProjection = "full" | "inventory" | "executive";

export interface ReportLoadPlan {
  datasets: readonly ReportDataset[];
  assetProjection: ReportAssetProjection;
  requests: boolean;
  decisionCounts: boolean;
  depreciationRules: boolean;
  financialQuality: boolean;
}

const PLANS: Record<ReportTab, ReportLoadPlan> = {
  executive: { datasets: ["assets", "maintenance", "references"], assetProjection: "executive", requests: false, decisionCounts: true, depreciationRules: true, financialQuality: false },
  inventory: { datasets: ["assets", "consumables", "references"], assetProjection: "inventory", requests: false, decisionCounts: false, depreciationRules: false, financialQuality: true },
  requests: { datasets: [], assetProjection: "full", requests: true, decisionCounts: false, depreciationRules: false, financialQuality: false },
  maintenance: { datasets: ["maintenance"], assetProjection: "full", requests: false, decisionCounts: false, depreciationRules: false, financialQuality: false },
  custody: { datasets: ["assets", "references"], assetProjection: "full", requests: false, decisionCounts: false, depreciationRules: false, financialQuality: false },
};

/** One dependency map for server seeding and the selected browser panel. */
export function reportLoadPlan(tab: ReportTab): ReportLoadPlan {
  return PLANS[tab];
}

/** A lean inventory response cannot satisfy executive depreciation or custody reads. */
export function reportAssetCacheKey(scope: string, financial: boolean, projection: ReportAssetProjection): string {
  return `${scope}|assets|${financial}|${projection}`;
}

/** Presentation only: every underlying read still uses the visitor's RLS/RPC permissions. */
export function visibleReportTabs(
  isVisible: (feature: FeatureKey) => boolean,
  canReadCustomerReports: boolean,
): ReportTab[] {
  return REPORT_TAB_KEYS.filter((tab) => {
    if (tab === "requests") return isVisible("reports.requests") || (isVisible("reports.customerRequests") && canReadCustomerReports);
    if (tab === "inventory") return isVisible("reports.assets") || isVisible("reports.consumables");
    return isVisible(`reports.${tab}`);
  });
}

export function resolveReportTab(requested: string | null | undefined, visible: readonly ReportTab[]): ReportTab {
  return visible.find((tab) => tab === requested) ?? visible[0] ?? "executive";
}

export interface FinancialQualityPage<T> {
  rows: T[];
  nextOffset: number | null;
  error: string | null;
}

/** No partial download when a later page fails or a continuation stops advancing. */
export async function collectFinancialQualityPages<T>(
  fetchPage: (offset: number) => Promise<FinancialQualityPage<T>>,
  signal?: AbortSignal,
): Promise<T[]> {
  const rows: T[] = [];
  let offset = 0;
  do {
    signal?.throwIfAborted();
    const page = await fetchPage(offset);
    signal?.throwIfAborted();
    if (page.error !== null) throw new Error(page.error || "financial_data_quality_failed");
    rows.push(...page.rows);
    if (page.nextOffset === null) return rows;
    if (page.nextOffset <= offset || !Number.isSafeInteger(page.nextOffset)) throw new Error("financial_data_quality_invalid_continuation");
    offset = page.nextOffset;
  } while (true);
}
