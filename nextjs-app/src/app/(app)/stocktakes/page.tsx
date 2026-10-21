"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ClipboardCheck,
  ClipboardList,
  Download,
  Play,
  Plus,
  Printer,
  RefreshCw,
  ScanLine,
  ShieldCheck,
  TriangleAlert,
  Warehouse,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusChip } from "@/components/ui/status-chip";
import { inputClass } from "@/components/ui/form";
import { Toast, type ToastState } from "@/components/ui/toast";
import { StocktakeSessionList } from "@/components/stocktakes/stocktake-session-list";
import { StocktakeReviewControls } from "@/components/stocktakes/stocktake-review-controls";
import { STOCKTAKE_CLASSIFICATION_TONE, stocktakeSessionTone } from "@/components/stocktakes/stocktake-tones";
import { interpolate } from "@/lib/i18n";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { useCan, useSession } from "@/lib/session";
import { downloadCSV } from "@/lib/export";
import { getInventorySettings } from "@/lib/inventory-settings";
import { getFormOptions } from "@/lib/queries";
import {
  applyStocktakeAdjustments,
  createStocktake,
  decideStocktakeItem,
  getStocktakeDetail,
  getSystemInventoryReport,
  listStocktakeLocations,
  listStocktakes,
  recountStocktakeItem,
  reviewStocktake,
  scanStocktakeAsset,
  setStocktakeVarianceReason,
  startStocktake,
  submitStocktake,
  type StocktakeDetail,
  type StocktakeItem,
  type StocktakeSession,
  type SystemInventoryReport,
} from "@/lib/stocktakes";
import {
  filterStocktakeReviewItems,
  STOCKTAKE_VARIANCE_TYPES,
  stocktakeDecisionProgress,
  type StocktakeResolutionFilter,
  type StocktakeVarianceType,
} from "@/lib/stocktake-review";

const VARIANCE = new Set(["missing", "unexpected", "wrong_location"]);

export default function StocktakesPage() {
  const { t } = useAppPreferences();
  const { role } = useSession();
  const can = useCan();
  const manage = can("stocktake.manage")
    && ["admin", "it_manager", "technician", "warehouse_manager"].includes(role ?? "");
  const canReview = can("stocktake.manage") && ["admin", "it_manager"].includes(role ?? "");
  const [sessions, setSessions] = useState<StocktakeSession[]>([]);
  const [detail, setDetail] = useState<StocktakeDetail | null>(null);
  const [locations, setLocations] = useState<Array<{ id: string; name: string }>>([]);
  const [categories, setCategories] = useState<Array<{ id: string; name: string; name_ar?: string | null }>>([]);
  const [title, setTitle] = useState("");
  const [correctionTitle, setCorrectionTitle] = useState("");
  const [locationId, setLocationId] = useState("");
  const [startChoiceOpen, setStartChoiceOpen] = useState(false);
  const [scopeChoiceOpen, setScopeChoiceOpen] = useState(false);
  const [partialCategoryId, setPartialCategoryId] = useState("");
  const [systemReport, setSystemReport] = useState<SystemInventoryReport | null>(null);
  const [identifier, setIdentifier] = useState("");
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [reviewReason, setReviewReason] = useState("");
  const [variancesOnly, setVariancesOnly] = useState(true);
  const [varianceType, setVarianceType] = useState<StocktakeVarianceType | "all">("all");
  const [resolutionFilter, setResolutionFilter] = useState<StocktakeResolutionFilter>("unresolved");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [toast, setToast] = useState<ToastState>(null);
  const scanRef = useRef<HTMLInputElement>(null);

  async function reload(selectId?: string) {
    const [list, locationList, settings, formOptions] = await Promise.all([
      listStocktakes(),
      listStocktakeLocations(),
      getInventorySettings(),
      getFormOptions(),
    ]);
    if (list.error || locationList.error) {
      setToast({ type: "error", message: t.stocktakes.loadError });
      return;
    }
    setSessions(list.rows);
    setLocations(locationList.rows);
    setCategories((formOptions?.categories ?? []) as Array<{ id: string; name: string; name_ar?: string | null }>);
    // The configured default is FK-backed. Warehouse users can legitimately
    // receive a narrower location list, so do not discard a valid main
    // warehouse merely because it is absent from this presentation list.
    if (!locationId && settings.default_location_id) {
      setLocationId(settings.default_location_id);
    }
    const id = selectId ?? detail?.session.id;
    if (id) {
      const loaded = await getStocktakeDetail(id);
      if (loaded.error || !loaded.detail) {
        setToast({ type: "error", message: t.stocktakes.loadError });
      } else {
        setDetail(loaded.detail);
      }
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run(
    action: () => Promise<{ data: { ok?: boolean; id?: string } | null; error: unknown }>,
    success: string,
  ) {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    try {
      const result = await action();
      if (result.error || result.data?.ok !== true) {
        setToast({ type: "error", message: t.stocktakes.actionError });
        return false;
      }
      setToast({ type: "success", message: success });
      await reload(result.data.id ?? detail?.session.id);
      return true;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function create(correctionOf: string | null = null) {
    if (!locationId || title.trim().length < 3) {
      setToast({ type: "error", message: t.stocktakes.formRequired });
      return;
    }
    const ok = await run(
      () => createStocktake(title, locationId, correctionOf),
      t.stocktakes.created,
    );
    if (ok) setTitle("");
  }

  // جلسة تصحيح لجلسة مكتملة: الخادم يشترط نفس موقع الجلسة الأصلية (correction_location_mismatch)،
  // لذا نستخدم موقع الجلسة نفسها لا الموقع المختار أعلى الصفحة.
  async function createCorrection(session: { id: string; location_id: string }) {
    const value = correctionTitle.trim();
    if (value.length < 3 || value.length > 160) {
      setToast({ type: "error", message: t.stocktakes.formRequired });
      return;
    }
    const ok = await run(
      () => createStocktake(value, session.location_id, session.id),
      t.stocktakes.created,
    );
    if (ok) setCorrectionTitle("");
  }

  async function openSystemReport() {
    if (!locationId) return;
    setBusy(true);
    const result = await getSystemInventoryReport(locationId);
    setBusy(false);
    if (result.error || !result.report) {
      setToast({ type: "error", message: t.stocktakes.loadError });
      return;
    }
    setSystemReport(result.report);
    setStartChoiceOpen(false);
  }

  async function startFieldStocktake(scopeKind: "full" | "partial") {
    if (!locationId) return;
    if (scopeKind === "partial" && !partialCategoryId) {
      setToast({ type: "error", message: t.stocktakes.formRequired });
      return;
    }
    setStartChoiceOpen(false);
    setScopeChoiceOpen(false);
    const generatedTitle = `${t.stocktakes.fieldCountTitle} ${new Date().toISOString().slice(0, 10)}`;
    const result = await createStocktake(generatedTitle, locationId, null, scopeKind, scopeKind === "partial" ? partialCategoryId : null);
    if (result.error || result.data?.ok !== true || !result.data.id) {
      setToast({ type: "error", message: t.stocktakes.actionError });
      return;
    }
    const started = await startStocktake(result.data.id);
    if (started.error || started.data?.ok !== true) {
      setToast({ type: "error", message: t.stocktakes.actionError });
      await reload(result.data.id);
      return;
    }
    setToast({ type: "success", message: t.stocktakes.started });
    await reload(result.data.id);
  }

  async function scan() {
    if (!detail || !identifier.trim()) return;
    const ok = await run(
      () => scanStocktakeAsset(detail.session.id, identifier.trim()),
      t.stocktakes.scanned,
    );
    if (ok) {
      setIdentifier("");
      scanRef.current?.focus();
    }
  }

  const progress = useMemo(() => {
    if (!detail || detail.session.expected_count === 0) return 0;
    return Math.min(
      100,
      Math.round(
        (detail.session.observed_count / detail.session.expected_count) * 100,
      ),
    );
  }, [detail]);

  const varianceItems = useMemo(
    () => detail?.items.filter((item) => VARIANCE.has(item.classification ?? "")) ?? [],
    [detail],
  );
  const decisionProgress = useMemo(() => stocktakeDecisionProgress(varianceItems), [varianceItems]);
  const unresolvedVarianceCount = decisionProgress.unresolved;
  const shownItems = useMemo(() => {
    if (!detail || detail.session.review_state !== "submitted") return detail?.items ?? [];
    return filterStocktakeReviewItems(detail.items, {
      variancesOnly,
      classification: varianceType,
      resolution: resolutionFilter,
    });
  }, [detail, variancesOnly, varianceType, resolutionFilter]);

  const goToNextUnresolved = () => {
    const next = varianceItems.find((item) => !item.review_decision);
    if (!next) return;
    setVariancesOnly(true);
    setVarianceType("all");
    setResolutionFilter("unresolved");
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const targets = Array.from(document.querySelectorAll<HTMLElement>(`[data-stocktake-item="${next.id}"]`));
        targets.find((target) => target.offsetParent !== null)?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    });
  };

  function exportRows() {
    if (!detail) return;
    const rows = detail.items.map((item) => [
      detail.session.code,
      item.asset_tag,
      item.asset_name,
      item.classification,
      item.count_round,
      item.variance_reason,
      item.adjustment_applied ? "true" : "false",
      item.observed_at,
    ]);
    downloadCSV(
      `stocktake-${detail.session.code}.csv`,
      [
        "session",
        "asset_tag",
        "asset_name",
        "classification",
        "count_round",
        "variance_reason",
        "adjustment_applied",
        "observed_at",
      ],
      rows,
    );
  }

  const stateLabel = (value: string) =>
    t.stocktakes.states[value as keyof typeof t.stocktakes.states] ?? value;
  const classificationLabel = (value: StocktakeItem["classification"]) =>
    value
      ? t.stocktakes.classifications[
        value as keyof typeof t.stocktakes.classifications
      ] ?? value
      : t.common.dash;


  const classificationChip = (value: StocktakeItem["classification"]) =>
    value
      ? <StatusChip tone={STOCKTAKE_CLASSIFICATION_TONE[value] ?? "neu"} size="sm">{classificationLabel(value)}</StatusChip>
      : <span className="text-muted">{t.common.dash}</span>;
  const reviewControls = (item: StocktakeItem) => detail && (
    <StocktakeReviewControls item={item} reason={reasons[item.id] ?? item.variance_reason ?? ""} setReason={(value) => setReasons((current) => ({ ...current, [item.id]: value }))} busy={busy} manage={manage} canReview={canReview} reviewState={detail.session.review_state} status={detail.session.status} onSave={() => void run(() => setStocktakeVarianceReason(detail.session.id, item.id, reasons[item.id] ?? item.variance_reason ?? ""), t.stocktakes.reasonSaved)} onStartRecount={() => void run(() => recountStocktakeItem(detail.session.id, item.id, reasons[item.id] ?? item.variance_reason ?? ""), t.stocktakes.recountStarted)} onDecide={(decision) => void run(() => decideStocktakeItem(detail.session.id, item.id, decision, reasons[item.id] ?? item.variance_reason ?? "Manager review"), t.stocktakes.reasonSaved)} saveLabel={t.common.save} t={t.stocktakes} />
  );
  const choiceClass = "block w-full rounded-card border border-line p-4 text-start transition-colors hover:bg-surface-2";

  return (
    <div>
      <PageHeader
        title={t.stocktakes.title}
        description={t.stocktakes.subtitle}
        actions={<>
          <Button variant="ghost" onClick={() => void reload()}>
            <RefreshCw aria-hidden="true" className="h-4 w-4" />
            {t.common.refresh}
          </Button>
          {manage && (
            <Button disabled={busy || !locationId} onClick={() => setStartChoiceOpen(true)}>
              <Plus aria-hidden="true" className="h-4 w-4" />{t.stocktakes.startNew}
            </Button>
          )}
        </>}
      />

      {manage && (
        locationId ? (
          <p className="mb-4 inline-flex items-center gap-2 rounded-full bg-sunk px-3 py-1.5 text-[12.5px] text-fg-2">
            <Warehouse aria-hidden="true" className="h-3.5 w-3.5 text-muted" />
            {t.stocktakes.mainWarehouse}: <span className="font-semibold text-fg">{locations.find((location) => location.id === locationId)?.name ?? t.common.dash}</span>
          </p>
        ) : (
          <p role="alert" className="mb-4 flex items-start gap-2 rounded-xl bg-warn-soft px-4 py-3 text-[13px] font-medium text-warn">
            <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />{t.stocktakes.mainWarehouseMissing}
          </p>
        )
      )}

      {systemReport && (
        <Card className="mb-5 overflow-hidden">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
            <div className="min-w-0">
              <h2 className="font-display text-[17px] font-semibold text-fg">{t.stocktakes.systemReport}</h2>
              <p className="mt-0.5 text-[13px] text-muted">{t.stocktakes.systemReportNotice}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => window.print()}><Printer aria-hidden="true" className="h-4 w-4" />{t.stocktakes.printReport}</Button>
              <Button size="sm" variant="outline" onClick={() => downloadCSV("system-inventory-report.csv", ["registered", "available", "reserved", "delivered", "in_maintenance", "data_issues"], [[systemReport.registered, systemReport.available, systemReport.reserved, systemReport.delivered, systemReport.inMaintenance, systemReport.dataIssues]])}><Download aria-hidden="true" className="h-4 w-4" />{t.stocktakes.export}</Button>
            </div>
          </div>
          <dl className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
            <Metric label={t.stocktakes.reportRegistered} value={systemReport.registered} />
            <Metric label={t.stocktakes.reportAvailable} value={systemReport.available} tone="text-ok" />
            <Metric label={t.stocktakes.reportReserved} value={systemReport.reserved} tone="text-res" />
            <Metric label={t.stocktakes.reportDelivered} value={systemReport.delivered} />
            <Metric label={t.stocktakes.reportMaintenance} value={systemReport.inMaintenance} tone="text-warn" />
            <Metric label={t.stocktakes.reportDataIssues} value={systemReport.dataIssues} tone="text-bad" />
          </dl>
        </Card>
      )}

      <div className="grid gap-6">
        <StocktakeSessionList
          sessions={sessions}
          selectedId={detail?.session.id ?? null}
          stateLabel={stateLabel}
          t={t.stocktakes}
          dash={t.common.dash}
          onSelect={async (session) => {
            const loaded = await getStocktakeDetail(session.id);
            if (loaded.detail) {
              setDetail(loaded.detail);
              setVariancesOnly(true);
              setVarianceType("all");
              setResolutionFilter("unresolved");
              setReviewReason("");
            }
          }}
        />

        {!detail ? (
          <Card className="flex min-h-64 items-center justify-center">
            <EmptyState icon={ClipboardList} title={t.stocktakes.selectSession} />
          </Card>
        ) : (
          <Card>
            <section aria-labelledby="stocktake-detail-title">
              <div className="flex flex-col gap-5 border-b border-line p-5 sm:p-6">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2.5">
                      <bdi dir="ltr" className="font-mono text-[13px] font-medium text-brand-ink">{detail.session.code}</bdi>
                      <StatusChip tone={stocktakeSessionTone(detail.session)}>{stateLabel(detail.session.review_state)}</StatusChip>
                    </div>
                    <h2 id="stocktake-detail-title" className="mt-1.5 font-display text-[22px] font-semibold leading-snug text-fg">{detail.session.title}</h2>
                    <p className="mt-0.5 text-[13px] text-muted">
                      {detail.session.location_name ?? t.common.dash}
                      {` · ${t.stocktakes.scope}: ${detail.session.scope_label ?? (detail.session.scope_kind === "partial" ? t.stocktakes.partialInventory : t.stocktakes.fullInventory)}`}
                      {detail.session.blind_count ? ` · ${t.stocktakes.blind}` : ""}
                    </p>
                  </div>
                  <Button variant="outline" onClick={exportRows}>
                    <Download aria-hidden="true" className="h-4 w-4" />
                    {t.stocktakes.export}
                  </Button>
                </div>

                <div>
                  <div className="mb-2 flex items-baseline justify-between text-[13px]">
                    <span className="font-semibold text-fg-2">{t.stocktakes.progress}</span>
                    <span className="tabular-nums text-muted">{detail.session.observed_count}/{detail.session.expected_count} · {progress}%</span>
                  </div>
                  <div role="progressbar" aria-label={t.stocktakes.progressLabel} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} className="h-2.5 overflow-hidden rounded-full bg-sunk">
                    <div
                      className={`h-full rounded-full transition-all ${detail.session.status === "completed" ? "bg-ok" : "bg-brand"}`}
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                </div>

                <dl className="grid grid-cols-3 overflow-hidden rounded-xl bg-surface-2 py-2">
                  <Metric label={t.stocktakes.expected} value={detail.session.expected_count} />
                  <Metric label={t.stocktakes.observed} value={detail.session.observed_count} tone="text-brand-ink" />
                  <Metric label={t.stocktakes.variances} value={detail.session.variance_count} tone={detail.session.variance_count > 0 ? "text-warn" : undefined} />
                </dl>

                {manage && detail.session.status === "draft" && (
                  <div>
                    <Button
                      disabled={busy}
                      onClick={() => void run(
                        () => startStocktake(detail.session.id),
                        t.stocktakes.started,
                      )}
                    >
                      <Play aria-hidden="true" className="h-4 w-4" />
                      {t.stocktakes.start}
                    </Button>
                  </div>
                )}

                {manage
                  && detail.session.status === "in_progress"
                  && ["counting", "recount"].includes(detail.session.review_state) && (
                  <div className="rounded-xl border border-line bg-surface-2 p-5">
                    <label className="ui-label text-brand-ink" htmlFor="stocktake-scan">
                      {t.stocktakes.scanFirst}
                    </label>
                    <div className="flex gap-2">
                      <input
                        ref={scanRef}
                        id="stocktake-scan"
                        autoFocus
                        dir="ltr"
                        value={identifier}
                        onChange={(event) => setIdentifier(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") void scan();
                        }}
                        placeholder={t.stocktakes.scanPlaceholder}
                        className={`${inputClass} min-h-11 flex-1 font-mono`}
                      />
                      <Button disabled={busy} onClick={() => void scan()} className="min-h-11">
                        <ScanLine aria-hidden="true" className="h-4 w-4" />
                        {t.stocktakes.scan}
                      </Button>
                    </div>
                    <p className="ui-hint">{t.stocktakes.identifiers}</p>
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => void run(
                        () => submitStocktake(detail.session.id),
                        t.stocktakes.submitted,
                      )}
                      className="mt-4"
                    >
                      <ClipboardCheck aria-hidden="true" className="h-4 w-4" />
                      {t.stocktakes.submit}
                    </Button>
                  </div>
                )}

                {canReview && detail.session.review_state === "submitted" && (
                  <div className="grid gap-3 rounded-xl border border-line p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="text-sm font-semibold text-fg">
                          <span className="tabular-nums">{decisionProgress.resolved} / {decisionProgress.total}</span> {t.stocktakes.decisionsRecorded}
                        </p>
                        {shownItems.some((item) => VARIANCE.has(item.classification ?? "") && !item.review_decision) && (
                          <p className="mt-0.5 text-xs font-medium text-warn">
                            <span className="tabular-nums">{unresolvedVarianceCount}</span> {t.stocktakes.decisionsRemaining}
                          </p>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {unresolvedVarianceCount > 0 && (
                          <Button variant="outline" onClick={goToNextUnresolved}>
                            {t.stocktakes.nextUnresolved}
                          </Button>
                        )}
                        <Button
                          disabled={busy || unresolvedVarianceCount > 0}
                          onClick={() => void run(
                            () => applyStocktakeAdjustments(detail.session.id),
                            t.stocktakes.approved,
                          )}
                        >
                          <ShieldCheck aria-hidden="true" className="h-4 w-4" />
                          {t.stocktakes.applyAndComplete}
                        </Button>
                      </div>
                    </div>
                    <div className="grid gap-2 border-t border-line pt-3">
                      <textarea
                        value={reviewReason}
                        onChange={(event) => setReviewReason(event.target.value)}
                        placeholder={t.stocktakes.rejectionReason}
                        aria-label={t.stocktakes.rejectionReason}
                        className={`${inputClass} min-h-20 resize-none`}
                      />
                      <Button
                        variant="danger-ghost"
                        disabled={busy || reviewReason.trim().length < 3}
                        onClick={() => void run(
                          () => reviewStocktake(detail.session.id, "rejected", reviewReason),
                          t.stocktakes.rejected,
                        )}
                        className="justify-self-start"
                      >
                        {t.stocktakes.reject}
                      </Button>
                    </div>
                  </div>
                )}

                {manage && detail.session.status === "completed" && (
                  <div className="grid gap-3">
                    <div className="flex flex-wrap gap-2">
                      <Button onClick={() => window.print()}><Printer aria-hidden="true" className="h-4 w-4" />{t.stocktakes.printPhysicalReport}</Button>
                    </div>
                    <form
                      className="grid gap-2 rounded-control border border-line bg-surface-2 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"
                      onSubmit={(event) => { event.preventDefault(); void createCorrection(detail.session); }}
                    >
                      <div className="min-w-0">
                        <label htmlFor="stocktake-correction-title" className="ui-label">{t.stocktakes.correctionTitleLabel}</label>
                        <input
                          id="stocktake-correction-title"
                          name="correction_title"
                          value={correctionTitle}
                          onChange={(event) => setCorrectionTitle(event.target.value)}
                          maxLength={160}
                          aria-describedby="stocktake-correction-hint"
                          className={inputClass}
                        />
                        <p id="stocktake-correction-hint" className="ui-hint">
                          {interpolate(t.stocktakes.correctionTitleHint, { code: detail.session.code })}
                        </p>
                      </div>
                      <Button type="submit" variant="outline" disabled={busy || correctionTitle.trim().length < 3} className="sm:mb-6">
                        {t.stocktakes.createCorrection}
                      </Button>
                    </form>
                  </div>
                )}
              </div>

              <div className="sticky top-14 z-10 flex flex-wrap items-center justify-between gap-2 border-b border-line bg-surface px-5 py-3 sm:px-6 md:top-[60px]">
                <h3 className="font-display text-[15px] font-semibold text-fg">
                  {detail.session.blind_count
                    && ["counting", "recount"].includes(detail.session.review_state)
                    ? t.stocktakes.observedOnly
                    : t.stocktakes.results}
                </h3>
                {detail.session.review_state === "submitted" && (
                  <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
                    <select aria-label={t.stocktakes.discrepancyTypeFilter} value={varianceType} onChange={(event) => setVarianceType(event.target.value as StocktakeVarianceType | "all")} className={`${inputClass} flex-1 sm:w-52 sm:flex-none`}>
                      <option value="all">{t.stocktakes.allDiscrepancyTypes}</option>
                      {STOCKTAKE_VARIANCE_TYPES.map((type) => <option key={type} value={type}>{classificationLabel(type)}</option>)}
                    </select>
                    <select aria-label={t.stocktakes.resolutionFilter} value={resolutionFilter} onChange={(event) => setResolutionFilter(event.target.value as StocktakeResolutionFilter)} className={`${inputClass} flex-1 sm:w-44 sm:flex-none`}>
                      <option value="unresolved">{t.stocktakes.unresolvedOnly}</option>
                      <option value="resolved">{t.stocktakes.resolvedOnly}</option>
                      <option value="all">{t.stocktakes.allDecisions}</option>
                    </select>
                    {detail.items.length > varianceItems.length && (
                      <Button size="sm" variant="outline" onClick={() => setVariancesOnly((value) => !value)}>
                        {variancesOnly ? t.stocktakes.showAllResults : t.stocktakes.showVariancesOnly}
                      </Button>
                    )}
                  </div>
                )}
              </div>
              {detail.session.review_state === "submitted" && (
                <div className="md:hidden">
                  {shownItems.length === 0 ? <p className="p-8 text-center text-sm text-muted">{t.stocktakes.noReviewMatches}</p> : shownItems.map((item) => (
                    <article key={item.id} data-stocktake-item={item.id} className="scroll-mt-28 border-b border-line p-4 last:border-b-0">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0"><p className="tag text-xs font-semibold text-brand-ink">{item.asset_tag}</p><p className="mt-0.5 text-sm text-fg">{item.asset_name}</p></div>
                        <span className="shrink-0">{classificationChip(item.classification)}</span>
                      </div>
                      <p className="mt-2 text-xs text-muted">{t.stocktakes.round}: <span className="tabular-nums">{item.count_round}</span></p>
                      <div className="mt-3">{reviewControls(item)}</div>
                    </article>
                  ))}
                </div>
              )}
              <div tabIndex={0} className={detail.session.review_state === "submitted" ? "hidden overflow-x-auto md:block" : "overflow-x-auto"}>
                <table className="ui-table">
                  <thead>
                    <tr>
                      <th scope="col">{t.stocktakes.asset}</th>
                      <th scope="col">{t.stocktakes.classification}</th>
                      <th scope="col">{t.stocktakes.round}</th>
                      <th scope="col">{t.stocktakes.reason}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shownItems.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="py-10 text-center text-muted">
                          {detail.session.review_state === "submitted" ? t.stocktakes.noReviewMatches : t.stocktakes.noObservations}
                        </td>
                      </tr>
                    ) : shownItems.map((item) => (
                      <tr key={item.id} data-stocktake-item={item.id} className="scroll-mt-28">
                        <td className="py-3">
                          <p className="tag text-xs font-semibold text-brand-ink">{item.asset_tag}</p>
                          <p className="text-fg">{item.asset_name}</p>
                        </td>
                        <td>{classificationChip(item.classification)}</td>
                        <td className="tabular-nums">{item.count_round}</td>
                        <td className="min-w-72 py-3">{reviewControls(item)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </Card>
        )}
      </div>
      {detail?.session.status === "completed" && (
        <section className="print-stocktake-report" dir={t.stocktakes.physicalReport === "Physical Inventory Report" ? "ltr" : "rtl"}>
          <header><p>{t.stocktakes.physicalReport}</p><h1>{detail.session.code}</h1><p>{detail.session.location_name ?? t.stocktakes.mainWarehouse} · {detail.session.scope_label ?? t.stocktakes.fullInventory}</p></header>
          <h2>{t.stocktakes.reportSummary}</h2><dl><div><dt>{t.stocktakes.expected}</dt><dd>{detail.session.expected_count}</dd></div><div><dt>{t.stocktakes.observed}</dt><dd>{detail.session.observed_count}</dd></div><div><dt>{t.stocktakes.variances}</dt><dd>{detail.session.variance_count}</dd></div></dl>
          <h2>{t.stocktakes.results}</h2><table><thead><tr><th>{t.stocktakes.asset}</th><th>{t.stocktakes.classification}</th><th>{t.stocktakes.reason}</th></tr></thead><tbody>{detail.items.map((item) => <tr key={item.id}><td>{item.asset_tag} · {item.asset_name}</td><td>{classificationLabel(item.classification)}</td><td>{item.review_note ?? item.variance_reason ?? t.common.dash}</td></tr>)}</tbody></table>
          <footer>{t.stocktakes.reportGenerated}: {new Date().toLocaleString()}</footer>
        </section>
      )}
      <Toast toast={toast} onDone={() => setToast(null)} />
      <Dialog open={startChoiceOpen} onClose={() => setStartChoiceOpen(false)} title={t.stocktakes.startNew} footer={<Button variant="outline" onClick={() => setStartChoiceOpen(false)}>{t.common.cancel}</Button>}>
        <div className="grid gap-3">
          <button type="button" onClick={() => void openSystemReport()} className={choiceClass}><p className="font-semibold text-fg">{t.stocktakes.systemReport}</p><p className="mt-1 text-[13px] text-muted">{t.stocktakes.systemReportNotice}</p></button>
          <button type="button" onClick={() => setScopeChoiceOpen(true)} className={`${choiceClass} border-brand bg-brand-soft hover:bg-brand-soft`}><p className="font-semibold text-fg">{t.stocktakes.fieldCount}</p><p className="mt-1 text-[13px] text-fg-2">{t.stocktakes.fieldCountHint}</p></button>
        </div>
      </Dialog>
      <Dialog open={scopeChoiceOpen} onClose={() => setScopeChoiceOpen(false)} title={t.stocktakes.fieldCount} footer={<Button variant="outline" onClick={() => setScopeChoiceOpen(false)}>{t.common.cancel}</Button>}>
        <div className="grid gap-3">
          <button type="button" onClick={() => void startFieldStocktake("full")} className={`${choiceClass} border-brand`}><p className="font-semibold text-fg">{t.stocktakes.fullInventory}</p><p className="mt-1 text-[13px] text-muted">{t.stocktakes.mainWarehouse}</p></button>
          <div className="rounded-card border border-line p-4">
            <p className="font-semibold text-fg">{t.stocktakes.partialInventory}</p>
            <select aria-label={t.stocktakes.partialInventory} value={partialCategoryId} onChange={(e) => setPartialCategoryId(e.target.value)} className={`${inputClass} mt-3`}><option value="">{t.assets.allCategories}</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name_ar ?? category.name}</option>)}</select>
            <Button disabled={!partialCategoryId} onClick={() => void startFieldStocktake("partial")} className="mt-3">{t.stocktakes.start}</Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="px-4 py-3">
      <dt className="text-[12.5px] text-fg-2">{label}</dt>
      <dd className={`mt-1 font-display text-[28px] font-medium leading-tight tabular-nums ${tone ?? "text-fg"}`}>{value}</dd>
    </div>
  );
}
