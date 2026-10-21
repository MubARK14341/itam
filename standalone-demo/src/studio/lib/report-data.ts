"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { getActionAlertOperationalCounts } from "./action-center";
import { getReportData, getFinancialDataQuality, listDepreciationRules } from "./queries";
import { getRequestsReport, getRequestOperationalCounts } from "./requests";
import type { DepreciationRule } from "./depreciation";
import type { ReportTab } from "./report-layout";
import { collectFinancialQualityPages, reportAssetCacheKey, reportLoadPlan, type ReportDataset } from "./report-load-plan";
import { readEpochCookie, subscribeReadInvalidation } from "./supabase/read-prefetch";

type ReportData = Awaited<ReturnType<typeof getReportData>>;
type QualityData = Awaited<ReturnType<typeof getFinancialDataQuality>>;
type ResourceValues = Record<ReportDataset, ReportData> & {
  requests: Awaited<ReturnType<typeof getRequestsReport>>["rows"];
  decisions: number;
  depreciation: DepreciationRule[];
};
type Resource = keyof ResourceValues;
type Entry = { phase: "loading" | "ready" | "error"; value?: ResourceValues[Resource]; error?: string };

const EMPTY_DATA: ReportData = {
  assets: [], consumables: [], maintenance: [], txns: [], categories: [], locations: [],
  departments: [], companies: [], pools: [], error: null,
};
const EMPTY_QUALITY = { summary: null, rows: [], nextOffset: null, error: null } satisfies QualityData;
const EMPTY_REQUESTS: ResourceValues["requests"] = [];
const EMPTY_RULES: DepreciationRule[] = [];

/** Session-scoped, mounted-page cache. A failed source never looks like a valid empty report. */
export function useReportData({ tab, financial, identityKey, enabled }: {
  tab: ReportTab; financial: boolean; identityKey: string; enabled: boolean;
}) {
  const [epoch, setEpoch] = useState(readEpochCookie);
  const [invalidationVersion, invalidated] = useReducer((value: number) => value + 1, 0);
  const scope = `${identityKey}|${epoch}|${invalidationVersion}`;
  const activeScope = useRef(scope);
  activeScope.current = scope;
  const cache = useRef(new Map<string, Entry>());
  const controllers = useRef(new Map<string, AbortController>());
  const [, changed] = useReducer((value: number) => value + 1, 0);
  const [retryVersion, retryChanged] = useReducer((value: number) => value + 1, 0);
  const [quality, setQuality] = useState({ scope, data: EMPTY_QUALITY as QualityData, loaded: false, loading: false, exporting: false, error: null as string | null });
  const plan = reportLoadPlan(tab);
  const assetFinancial = financial && tab !== "custody";
  const keyFor = useCallback((name: Resource) => name === "assets"
    ? reportAssetCacheKey(scope, assetFinancial, plan.assetProjection)
    : `${scope}|${name}|${financial}`, [scope, assetFinancial, financial, plan.assetProjection]);
  const required = useMemo<Resource[]>(() => [...plan.datasets, ...(plan.requests ? ["requests" as const] : []), ...(plan.decisionCounts ? ["decisions" as const] : []), ...(plan.depreciationRules && financial ? ["depreciation" as const] : [])], [plan, financial]);

  useEffect(() => {
    const check = () => setEpoch(readEpochCookie());
    const unsubscribe = subscribeReadInvalidation(() => {
      controllers.current.forEach((controller) => controller.abort());
      cache.current.clear();
      setEpoch(readEpochCookie());
      invalidated();
    });
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const activeControllers = controllers.current;
    cache.current.clear();
    setQuality({ scope, data: EMPTY_QUALITY, loaded: false, loading: false, exporting: false, error: null });
    changed();
    return () => {
      activeControllers.forEach((controller) => controller.abort());
      activeControllers.clear();
    };
  }, [scope]);

  const start = useCallback(<K extends Resource>(name: K, load: (signal: AbortSignal) => Promise<ResourceValues[K]>) => {
    const key = keyFor(name);
    if (cache.current.has(key)) return;
    const controller = new AbortController();
    controllers.current.set(key, controller);
    cache.current.set(key, { phase: "loading" });
    changed();
    void load(controller.signal).then((value) => {
      if (controller.signal.aborted || activeScope.current !== scope) return;
      cache.current.set(key, { phase: "ready", value });
      changed();
    }).catch((error: unknown) => {
      if (controller.signal.aborted || activeScope.current !== scope) return;
      cache.current.set(key, { phase: "error", error: error instanceof Error && error.message ? error.message : "report_read_failed" });
      changed();
    }).finally(() => {
      if (controllers.current.get(key) === controller) controllers.current.delete(key);
    });
  }, [keyFor, scope]);

  const loadQuality = useCallback((offset = 0) => {
    const key = `${scope}|quality`;
    if (controllers.current.has(key)) return;
    const controller = new AbortController();
    controllers.current.set(key, controller);
    setQuality((previous) => ({ ...previous, scope, loading: true, error: null }));
    void getFinancialDataQuality({ offset, pageSize: 200, signal: controller.signal }).then((page) => {
      if (controller.signal.aborted || activeScope.current !== scope) return;
      if (page.error !== null) throw new Error(page.error || "financial_data_quality_failed");
      setQuality((previous) => ({
        ...previous, scope, loaded: true, loading: false, error: null,
        data: {
          ...page,
          summary: offset === 0 ? page.summary : previous.data.summary,
          rows: offset === 0 ? page.rows : [...previous.data.rows, ...page.rows],
        },
      }));
    }).catch((error: unknown) => {
      if (controller.signal.aborted || activeScope.current !== scope) return;
      setQuality((previous) => ({ ...previous, scope, loading: false, error: error instanceof Error && error.message ? error.message : "financial_data_quality_failed" }));
    }).finally(() => {
      if (controllers.current.get(key) === controller) controllers.current.delete(key);
    });
  }, [scope]);

  useEffect(() => {
    const needed = new Set(enabled ? required.map(keyFor) : []);
    let cancelled = false;
    for (const [key, entry] of cache.current) {
      if (entry.phase !== "loading" || needed.has(key)) continue;
      controllers.current.get(key)?.abort();
      controllers.current.delete(key);
      cache.current.delete(key);
      cancelled = true;
    }
    if (cancelled) changed();
    if (!enabled || !plan.financialQuality || !financial) {
      const key = `${scope}|quality`, pending = controllers.current.get(key);
      if (pending) {
        pending.abort();
        controllers.current.delete(key);
        setQuality((previous) => ({ ...previous, loading: false }));
      }
    }
  }, [enabled, required, keyFor, scope, plan.financialQuality, financial]);

  useEffect(() => {
    if (!enabled) return;
    for (const dataset of plan.datasets) start(dataset, async (signal) => {
      const result = await getReportData(dataset === "assets" ? assetFinancial : financial, {
        datasets: [dataset], assetProjection: plan.assetProjection, signal,
      });
      if (result.error !== null) throw new Error(result.error || "report_read_failed");
      return result;
    });
    if (plan.requests) start("requests", async (signal) => {
      const result = await getRequestsReport(financial, { signal });
      if (result.error !== null) throw new Error(result.error || "request_report_failed");
      return result.rows;
    });
    if (plan.decisionCounts) start("decisions", async (signal) => {
      const result = await getActionAlertOperationalCounts({ signal });
      signal.throwIfAborted();
      if (result.error !== null || !result.counts) throw new Error(result.error || "action_counts_failed");
      return result.counts.needs_action;
    });
    if (plan.depreciationRules && financial) start("depreciation", async (signal) => {
      const result = await listDepreciationRules(true, { signal, strictFinancial: true });
      signal.throwIfAborted();
      if (result.error !== null) throw new Error(result.error || "depreciation_report_failed");
      return result.lifecycleAvailable ? result.rows as DepreciationRule[] : [];
    });
    if (plan.financialQuality && financial && (quality.scope !== scope || (!quality.loaded && !quality.loading && !quality.error))) loadQuality();
  }, [enabled, plan, start, financial, assetFinancial, retryVersion, loadQuality, scope, quality.scope, quality.loaded, quality.loading, quality.error]);

  const read = <K extends Resource>(name: K): ResourceValues[K] | undefined => cache.current.get(keyFor(name))?.value as ResourceValues[K] | undefined;
  const errors = required.map((name) => cache.current.get(keyFor(name))).filter((entry) => entry?.phase === "error");
  const loading = enabled && required.some((name) => {
    const phase = cache.current.get(keyFor(name))?.phase;
    return phase === undefined || phase === "loading";
  });
  const assetData = read("assets"), consumableData = read("consumables"), maintenanceData = read("maintenance"), references = read("references");
  const data = useMemo(() => {
    return {
      ...EMPTY_DATA,
      assets: assetData?.assets ?? [], maintenance: maintenanceData?.maintenance ?? [],
      consumables: consumableData?.consumables ?? [], txns: consumableData?.txns ?? [],
      categories: references?.categories ?? [], locations: references?.locations ?? [],
      departments: references?.departments ?? [], companies: references?.companies ?? [],
    };
  }, [assetData, consumableData, maintenanceData, references]);

  const assertFresh = () => {
    if (activeScope.current !== scope || readEpochCookie() !== epoch) {
      setEpoch(readEpochCookie());
      throw new Error("report_data_changed");
    }
    if (!enabled || required.some((name) => cache.current.get(keyFor(name))?.phase !== "ready")) throw new Error("report_not_ready");
  };

  return {
    data, reqRows: read("requests") ?? EMPTY_REQUESTS, deprRules: read("depreciation") ?? EMPTY_RULES, decisionCount: read("decisions") ?? 0,
    loading, error: errors[0]?.error ?? null,
    retry: () => {
      for (const name of required) {
        const key = keyFor(name);
        if (cache.current.get(key)?.phase === "error") cache.current.delete(key);
      }
      changed(); retryChanged();
    },
    quality: quality.scope === scope ? quality : { scope, data: EMPTY_QUALITY, loaded: false, loading: false, exporting: false, error: null },
    loadMoreQuality: () => { if (quality.data.nextOffset !== null) loadQuality(quality.data.nextOffset); },
    retryQuality: () => loadQuality(quality.loaded ? quality.data.nextOffset ?? 0 : 0),
    assertFresh,
    prepareExecutiveExport: async () => {
      assertFresh();
      const controller = new AbortController(), key = `${scope}|executive-export`;
      controllers.current.set(key, controller);
      try {
        const result = await getRequestOperationalCounts({ signal: controller.signal });
        controller.signal.throwIfAborted();
        assertFresh();
        if (result.error !== null || !result.counts) throw new Error(result.error || "request_counts_failed");
        return result.counts;
      } finally { if (controllers.current.get(key) === controller) controllers.current.delete(key); }
    },
    exportQuality: async () => {
      assertFresh();
      const controller = new AbortController(), key = `${scope}|quality-export`;
      controllers.current.set(key, controller);
      setQuality((previous) => ({ ...previous, exporting: true }));
      try {
        const rows = await collectFinancialQualityPages((offset) => getFinancialDataQuality({ offset, pageSize: 200, signal: controller.signal }), controller.signal);
        assertFresh();
        return rows;
      } finally {
        if (controllers.current.get(key) === controller) controllers.current.delete(key);
        if (!controller.signal.aborted && activeScope.current === scope) setQuality((previous) => ({ ...previous, exporting: false }));
      }
    },
  };
}
