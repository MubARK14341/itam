"use client";

import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, Pencil, ArrowDownToLine, ArrowUpFromLine, Upload, Paperclip, Eye, PackageOpen, TriangleAlert, CircleCheck, Download, History } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/card";
import { Button, buttonClass } from "@/components/ui/button";
import { StatusChip } from "@/components/ui/status-chip";
import { EmptyState } from "@/components/ui/empty-state";
import { Tabs, panelId, tabId } from "@/components/ui/tabs";
import { Toast, type ToastState } from "@/components/ui/toast";
import {
  getConsumable, getConsumableHistory, getConsumableAttachments, getFormOptions,
  getAttachmentUrl, uploadConsumableAttachment,
} from "@/lib/queries";
import { ReplenishDialog, IssueDialog, EditConsumableDialog } from "@/components/consumables/consumable-dialogs";
import { useSession, canManageConsumableCatalog, canManageConsumables, canSeeFinancial as canFinFn } from "@/lib/session";
import { useFeatureExposure } from "@/components/providers/feature-exposure-provider";
import { FeatureRoute } from "@/components/feature-gate";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { formatSAR, formatDate, formatDateTime } from "@/lib/format";
import { downloadCSV } from "@/lib/export";
import { interpolate } from "@/lib/i18n";
import type { Tone } from "@/lib/tone";
import type { Dict, Lang } from "@/lib/i18n";
import { safeInventoryReturnTo } from "@/lib/inventory-navigation";
import { friendlyErrorStrict } from "@/lib/user-facing-errors";
import { beginOperationalListRequest, cancelOperationalListRequest, completeOperationalListRequest,
  createOperationalListRequestGate, operationalListRequestSignal } from "@/lib/operational-list-request-gate";
import { beginConsumableLedgerRead, canExportConsumableLedger, completeConsumableLedgerRead,
  CONSUMABLE_LEDGER_DISPLAY_PAGE, type ConsumableLedgerState } from "@/lib/consumable-ledger";

type Tab = "stock" | "replenishment" | "usage";

export default function ConsumableProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { role, userId } = useSession();
  const { t, lang } = useAppPreferences();
  const { isVisible } = useFeatureExposure();
  const write = canManageConsumables(role);
  const catalogWrite = canManageConsumableCatalog(role);
  const fin = canFinFn(role);
  const tp = t.consumables.profile;
  // إظهار تدريجي (فوق شرط الدور write): صرف/توريد من 30، تعديل من 50، تبويبات التاريخ من 50.
  const expIssue = isVisible("consumables.issue");
  const expSupply = isVisible("consumables.supply");
  const expAddEdit = isVisible("consumables.addEdit");
  const expHistory = isVisible("consumables.history");

  const [c, setC] = useState<any>(null);
  const scope = `${userId ?? ""}|${role ?? ""}|${id}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const mounted = useRef(false);
  const loadGate = useRef(createOperationalListRequestGate());
  const [loadedScope, setLoadedScope] = useState<string | null>(null);
  const [ledger, setLedger] = useState<ConsumableLedgerState<any>>({ scope: "", rows: [], loading: false, complete: false, error: null });
  const [visibleLedgerRows, setVisibleLedgerRows] = useState(CONSUMABLE_LEDGER_DISPLAY_PAGE);
  const history = useMemo(() => ledger.scope === scope ? ledger.rows : [], [ledger.scope, ledger.rows, scope]);
  const ledgerComplete = canExportConsumableLedger(ledger, scope);
  const [attachments, setAttachments] = useState<any[]>([]);
  const [opts, setOpts] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("stock");
  const [toast, setToast] = useState<ToastState>(null);
  const [dialog, setDialog] = useState<null | "replenish" | "issue" | "edit">(null);
  const [uploading, setUploading] = useState(false);
  const [backHref, setBackHref] = useState("/assets");

  const load = useCallback(async () => {
    if (!mounted.current || scopeRef.current !== scope) return;
    const generation = beginOperationalListRequest(loadGate.current, true, true);
    if (generation === null) return;
    const signal = operationalListRequestSignal(loadGate.current, generation);
    setLedger((previous) => beginConsumableLedgerRead(previous, scope));
    try {
      const [{ consumable, error }, h, a] = await Promise.all([
        getConsumable(id, fin),
        getConsumableHistory(id, fin, { signal }),
        getConsumableAttachments(id),
      ]);
      if (scopeRef.current !== scope || !completeOperationalListRequest(loadGate.current, generation)) return;
      const historyResult = error !== null ? { rows: [], error: error || "consumable_profile_failed" } : h;
      setLedger((previous) => completeConsumableLedgerRead(previous, scope, historyResult));
      if (historyResult.error === null) setVisibleLedgerRows(CONSUMABLE_LEDGER_DISPLAY_PAGE);
      if (error === null) setC(consumable);
      setAttachments(a); setLoadedScope(scope); setLoading(false);
    } catch (error) {
      if (scopeRef.current !== scope || !completeOperationalListRequest(loadGate.current, generation)) return;
      setLedger((previous) => completeConsumableLedgerRead(previous, scope, { rows: [], error: error instanceof Error ? error.message : "consumable_history_failed" }));
      setLoadedScope(scope); setLoading(false);
    }
  }, [id, fin, scope]);

  useEffect(() => {
    mounted.current = true;
    setBackHref(safeInventoryReturnTo(new URLSearchParams(window.location.search).get("returnTo")));
    setC(null); setAttachments([]); setDialog(null); setToast(null); setOpts(null); setUploading(false); setTab("stock");
    setLoading(true); setVisibleLedgerRows(CONSUMABLE_LEDGER_DISPLAY_PAGE);
    void load();
    let active = true;
    getFormOptions().then((options) => { if (active && scopeRef.current === scope) setOpts(options); });
    const gate = loadGate.current;
    return () => { active = false; mounted.current = false; cancelOperationalListRequest(gate); };
  }, [load, scope]);

  // ?action=replenish|issue — تنبيهات المخزون تفتح نافذة التوريد/الصرف مباشرة
  // (نمط ?m= في الصيانة). طبقة تسهيل فقط: الدور + RPC المخزون الذرّي يحكمان التنفيذ.
  useEffect(() => {
    if (loading || loadedScope !== scope || !write) return;
    try {
      const a = new URLSearchParams(window.location.search).get("action");
      if (a === "replenish" || a === "issue") {
        setDialog(a);
        window.history.replaceState({}, "", `/consumables/${id}`);
      }
    } catch { /* غير حرج */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, write]);

  // متوسط سعر الشراء من حركات التوريد التي تحمل تكلفة
  const avgPrice = useMemo(() => {
    let qty = 0, cost = 0;
    for (const r of history) if (r.txn_type === "in" && r.unit_cost != null) {
      const q = Number(r.quantity || 0);
      qty += q;
      cost += r.total_cost != null ? Number(r.total_cost) : Number(r.unit_cost) * q;
    }
    return qty > 0 ? cost / qty : null;
  }, [history]);

  if (loading || loadedScope !== scope) return (
    <div className="animate-pulse space-y-4">
      <div className="h-8 w-56 rounded-lg bg-sunk" />
      <div className="h-40 rounded-card bg-sunk" />
      <div className="h-80 rounded-card bg-sunk" />
    </div>
  );
  if (!c) return <Card><EmptyState icon={PackageOpen} title={ledger.error ? tp.loadError + friendlyErrorStrict(ledger.error, lang) : tp.notFound}
    action={<div className="flex gap-2"><Link href={backHref} className={buttonClass("outline", "sm")}>{tp.back}</Link>
      {ledger.error && <Button size="sm" onClick={() => void load()} disabled={ledger.loading}>{t.reports.retry}</Button>}</div>} /></Card>;

  const lx = t.consumables.ledgerUx;
  const th = t.consumables.hist;
  const low = c.quantity_on_hand <= c.reorder_level;
  const out = c.quantity_on_hand === 0;
  const statusLabel = !c.is_active ? tp.statusInactive : out ? tp.statusOut : low ? tp.statusLow : tp.statusAvailable;
  const statusTone: Tone = !c.is_active ? "neu" : out ? "bad" : low ? "warn" : "ok";
  const unitLabel = (t.consumables.form.units as Record<string, string>)[c.unit] ?? c.unit;

  const replen = history.filter((r) => r.txn_type === "in");
  const usage = history.filter((r) => r.txn_type === "out");
  const visibleAttachments = fin
    ? attachments
    : attachments.filter((a) => a.kind !== "consumable_invoice" && a.kind !== "replenishment_invoice");

  // مقياس الرصيد مقابل حد إعادة الطلب — عرض فقط.
  const stock = Math.max(0, Number(c.quantity_on_hand) || 0);
  const reorder = Math.max(0, Number(c.reorder_level) || 0);
  const scale = Math.max(10, Math.ceil(Math.max(stock * 1.2, reorder * 2) / 10) * 10);
  const fillPct = Math.min(100, (stock / scale) * 100);
  const thrPct = Math.min(100, (reorder / scale) * 100);
  const ticks = [0, 1, 2, 3].map((i) => Math.round((scale / 3) * i));
  const fillCls = statusTone === "bad" ? "bg-bad" : statusTone === "warn" ? "bg-warn" : statusTone === "ok" ? "bg-ok" : "bg-muted";
  const stockTone = statusTone === "bad" ? "text-bad" : statusTone === "warn" ? "text-warn" : "text-fg";
  const alert = !c.is_active
    ? { cls: "bg-sunk text-fg-2", Icon: TriangleAlert, title: tp.statusInactive, text: lx.alertInactiveText }
    : out
      ? { cls: "bg-bad-soft text-bad", Icon: TriangleAlert, title: lx.alertOutTitle, text: lx.alertOutText }
      : low
        ? { cls: "bg-warn-soft text-warn", Icon: TriangleAlert, title: lx.alertLowTitle, text: interpolate(lx.alertLowText, { stock, reorder }) }
        : { cls: "bg-ok-soft text-ok", Icon: CircleCheck, title: lx.alertOkTitle, text: lx.alertOkText };

  const tabItems = ([
    { key: "stock", label: tp.tabs.stock, count: ledgerComplete ? history.length : undefined },
    { key: "replenishment", label: tp.tabs.replenishment, count: ledgerComplete ? replen.length : undefined },
    { key: "usage", label: tp.tabs.usage, count: ledgerComplete ? usage.length : undefined },
  ] as { key: Tab; label: string; count?: number }[]).filter((x) => x.key === "stock" || expHistory);
  const ledgerRows = tab === "replenishment" ? replen : tab === "usage" ? usage : history;
  const ledgerEmpty = tab === "replenishment" ? tp.emptyReplenishment : tab === "usage" ? tp.emptyUsage : tp.emptyHistory;
  const typeLabel = (x: string) => x === "in" ? th.in : x === "out" ? th.out : th.adjust;

  // تصدير السجل — نفس downloadCSV الآمن؛ الأعمدة المالية للمدير فقط (fin) كما في العرض.
  const exportLedger = () => {
    if (!canExportConsumableLedger(ledger, scopeRef.current)) return;
    const exported = downloadCSV(
      `consumable-ledger-${tab}.csv`,
      [th.date, th.type, th.quantity, th.balance, th.employee, th.department, th.supplier, th.note, lx.colUser,
        ...(fin ? [th.unitCost, th.totalCost, th.invoice] : [])],
      ledgerRows.map((r) => [
        formatDateTime(r.created_at, lang), typeLabel(r.txn_type), r.quantity, r.balance_after,
        r.employee ? (r.employee.full_name_ar ?? r.employee.full_name) : "",
        r.department ? (r.department.name_ar ?? r.department.name) : "",
        r.supplier ? (r.supplier.name_ar ?? r.supplier.name) : "",
        r.reason ?? "", r.actor ?? "",
        ...(fin ? [r.unit_cost, r.total_cost, r.invoice_number] : []),
      ]),
    );
    if (!exported) setToast({ type: "error", message: t.reports.exportFailed });
  };

  async function uploadAtt(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return;
    setUploading(true);
    const kind = file.type.startsWith("image/") ? "consumable_photo" : "other";
    const err = await uploadConsumableAttachment(id, file, kind);
    if (!mounted.current || scopeRef.current !== scope) return;
    setUploading(false); e.target.value = "";
    if (err) { setToast({ type: "error", message: t.assetDetail.docs.uploadError + err }); return; }
    setToast({ type: "success", message: t.assetDetail.docs.uploadedPending });
    const a = await getConsumableAttachments(id);
    if (mounted.current && scopeRef.current === scope) setAttachments(a);
  }

  return (
    <FeatureRoute feature="consumables.details">
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <Link href={backHref} className={buttonClass("ghost", "sm", "-ms-2.5 text-muted")}>
            <ArrowRight aria-hidden="true" className="h-4 w-4 ltr:rotate-180" />{tp.back}
          </Link>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-2">
            <h1 className="font-display text-[28px] font-semibold tracking-tight text-fg sm:text-[32px] sm:leading-10">{c.name}</h1>
            <StatusChip tone={statusTone}>{statusLabel}</StatusChip>
            <StatusChip tone="neu" dot={false}><PackageOpen aria-hidden="true" className="h-3 w-3" />{t.consumables.badge}</StatusChip>
          </div>
          <p className="mt-1 text-sm text-fg-2">
            {c.sku && <><span className="tag font-medium">{c.sku}</span> · </>}
            {c.category?.name_ar ?? c.category?.name ?? "—"} · {interpolate(lx.unitLabel, { unit: unitLabel })}
            {(c.supplier?.name_ar ?? c.supplier?.name) ? <> · {tp.supplier}: {c.supplier?.name_ar ?? c.supplier?.name}</> : null}
          </p>
        </div>
        {write && (expAddEdit || expSupply || expIssue) ? (
          <div className="flex flex-wrap gap-2">
            {catalogWrite && expAddEdit && <Button variant="outline" onClick={() => setDialog("edit")}><Pencil aria-hidden="true" className="h-4 w-4" />{t.common.edit}</Button>}
            {expIssue && <Button variant="outline" onClick={() => setDialog("issue")}><ArrowUpFromLine aria-hidden="true" className="h-4 w-4" />{t.consumables.issue}</Button>}
            {expSupply && <Button onClick={() => setDialog("replenish")}><ArrowDownToLine aria-hidden="true" className="h-4 w-4" />{t.consumables.supply}</Button>}
          </div>
        ) : <StatusChip tone="neu" dot={false}>{t.common.viewOnly}</StatusChip>}
      </header>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-5">
          {/* الرصيد مقابل حد إعادة الطلب */}
          <section aria-labelledby="stk-title" className="ui-surface overflow-hidden">
            <div className="flex flex-wrap items-start gap-6 px-5 pb-3.5 pt-4">
              <div className="w-[180px] shrink-0">
                <h2 id="stk-title" className="text-[13px] font-semibold text-muted">{lx.stockTitle}</h2>
                <div className="mt-3 flex items-baseline gap-2">
                  <span className={`font-display text-[44px] font-semibold leading-none tabular-nums ${stockTone}`}>{c.quantity_on_hand}</span>
                  <span className="text-muted">{unitLabel}</span>
                </div>
              </div>
              <dl className="grid min-w-0 flex-1 grid-cols-2 gap-y-3 sm:grid-cols-3">
                <StockStat label={tp.reorder} value={String(c.reorder_level)} />
                <StockStat label={tp.location} value={c.location?.name_ar ?? c.location?.name ?? "—"} small />
                {fin && <StockStat label={tp.stockValue} value={formatSAR(c.unit_cost != null ? c.unit_cost * c.quantity_on_hand : null, lang)} small />}
              </dl>
            </div>
            <div className="px-5 pb-4">
              <div className="relative pt-5">
                {reorder > 0 && (
                  <span aria-hidden="true" style={{ insetInlineStart: `${thrPct}%` }}
                    className="absolute top-0 -translate-x-1/2 whitespace-nowrap text-[11.5px] font-semibold text-fg-2 rtl:translate-x-1/2">
                    {interpolate(lx.thresholdMark, { reorder })}
                  </span>
                )}
                <div role="meter" aria-label={interpolate(lx.meterLabel, { stock, reorder })} aria-valuemin={0} aria-valuemax={scale} aria-valuenow={stock}
                  className="relative h-3 rounded-full bg-sunk">
                  <div className={`absolute inset-y-0 start-0 rounded-full transition-[width] ${fillCls}`} style={{ width: `${fillPct}%` }} />
                  {reorder > 0 && (
                    <div aria-hidden="true" className="absolute -inset-y-1 -ms-px w-0.5 rounded bg-fg" style={{ insetInlineStart: `${thrPct}%` }} />
                  )}
                </div>
                <div aria-hidden="true" className="mt-1.5 flex justify-between text-[11.5px] tabular-nums text-muted">
                  {ticks.map((v, i) => <span key={i}>{v}</span>)}
                </div>
              </div>
            </div>
            <div className={`flex flex-wrap items-center gap-x-2.5 gap-y-1 px-5 py-3 text-[13.5px] ${alert.cls}`}>
              <alert.Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
              <span className="font-semibold">{alert.title}</span>
              <span className="min-w-0 flex-1 text-fg-2">{alert.text}</span>
            </div>
          </section>

          {/* السجل كامل؛ نعرض 200 حركة تدريجيًا في كل تبويب. */}
          <section aria-labelledby="led-title" className="ui-surface overflow-hidden">
            <CardHeader id="led-title" title={lx.movementsTitle} description={lx.movementsDesc}
              actions={tabItems.length > 1 ? (
                <Tabs variant="segmented" idBase="consumable-ledger" label={lx.movementsFilter} items={tabItems} value={tab}
                  onChange={(next) => { setTab(next); setVisibleLedgerRows(CONSUMABLE_LEDGER_DISPLAY_PAGE); }} />
              ) : undefined} />
            {ledger.error && <div role="alert" className="border-t border-line bg-bad-soft px-5 py-3 text-sm text-bad">
              <p>{tp.loadError}{friendlyErrorStrict(ledger.error, lang)}</p>
              <p>{t.dashboard.v6.states.partialDescription}</p>
              <Button type="button" variant="outline" size="sm" onClick={() => void load()} disabled={ledger.loading} className="mt-2">{t.reports.retry}</Button>
            </div>}
            <div role={tabItems.length > 1 ? "tabpanel" : undefined}
              id={tabItems.length > 1 ? panelId("consumable-ledger", tab) : undefined}
              aria-labelledby={tabItems.length > 1 ? tabId("consumable-ledger", tab) : undefined}
              aria-busy={ledger.loading}>
              <HistoryTable rows={ledgerRows.slice(0, visibleLedgerRows)} fin={fin} t={t} lang={lang} empty={ledgerEmpty} />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line bg-surface-2 px-5 py-2.5 text-[13px] text-muted">
              <span className="tabular-nums" role="status">{ledger.loading ? t.common.loading : ledgerComplete
                ? `${Math.min(visibleLedgerRows, ledgerRows.length)} ${t.common.of} ${interpolate(lx.movementsCount, { count: ledgerRows.length })}`
                : t.reports.financialTruth.loadedRows.replace("{count}", String(ledgerRows.length))}</span>
              {visibleLedgerRows < ledgerRows.length && <Button type="button" variant="outline" size="sm"
                onClick={() => setVisibleLedgerRows((count) => count + CONSUMABLE_LEDGER_DISPLAY_PAGE)} disabled={ledger.loading}>{t.reports.showMore}</Button>}
              {ledgerRows.length > 0 && (
                <Button type="button" variant="ghost" size="sm" onClick={exportLedger} disabled={!ledgerComplete} className="text-brand-ink">
                  <Download aria-hidden="true" className="h-4 w-4" />{lx.exportLedger}
                </Button>
              )}
            </div>
          </section>
        </div>

        <aside className="min-w-0 space-y-5">
          {/* photo (latest consumable_photo) */}
          <ConsumablePhoto attachments={attachments} t={t} />

          <section aria-labelledby="inf-title" className="ui-surface px-5 pb-4 pt-4">
            <h2 id="inf-title" className="mb-3 font-display text-[15px] font-semibold text-fg">{tp.info}</h2>
            <dl className="grid grid-cols-[120px_minmax(0,1fr)] gap-y-2 text-[13px]">
              <Info label={tp.type} value={t.consumables.badge} />
              <Info label={tp.sku} value={c.sku} mono />
              <Info label={tp.category} value={c.category?.name_ar ?? c.category?.name} />
              <Info label={tp.company} value={c.company?.name} />
              <Info label={tp.supplier} value={c.supplier?.name_ar ?? c.supplier?.name} />
              {c.rfid_tag && <Info label={tp.rfid} value={c.rfid_tag} mono />}
              {fin && <Info label={tp.lastPrice} value={formatSAR(c.unit_cost, lang)} />}
              {fin && ledgerComplete && avgPrice != null && <Info label={tp.avgPrice} value={formatSAR(avgPrice, lang)} />}
            </dl>
            {c.notes && <p className="mt-3 rounded-lg bg-warn-soft px-3 py-2.5 text-[13px] text-fg">{c.notes}</p>}
            <p className="mt-3 border-t border-line pt-2.5 text-xs text-muted">{tp.noReturnNote}</p>
          </section>

          {expHistory && (
            <section aria-labelledby="att-title" className="ui-surface overflow-hidden">
              <div className="flex items-center justify-between gap-3 px-5 pb-2 pt-4">
                <h2 id="att-title" className="font-display text-[15px] font-semibold text-fg">{tp.tabs.attachments}</h2>
                {write && (
                  <label className={buttonClass("outline", "sm", "cursor-pointer")}>
                    <Upload aria-hidden="true" className="h-4 w-4" /> {uploading ? t.assetDetail.docs.uploading : t.assetDetail.docs.upload}
                    <input type="file" className="hidden" onChange={uploadAtt} disabled={uploading} />
                  </label>
                )}
              </div>
              {visibleAttachments.length === 0 ? <EmptyState compact icon={Paperclip} title={tp.emptyAttachments} /> : (
                <ul>
                  {visibleAttachments.map((a) => (
                    <li key={a.id} className="flex items-center gap-2 border-t border-line px-5 py-2.5 text-[13px] text-fg">
                      <Paperclip aria-hidden="true" className="h-4 w-4 shrink-0 text-muted" />
                      <button
                        type="button"
                        disabled={a.scan_status !== "clean"}
                        onClick={async () => {
                          const { url } = await getAttachmentUrl(
                            a.storage_path,
                            a.file_name,
                          );
                          if (url) window.open(url, "_blank");
                        }}
                        className="inline-flex min-w-0 items-center gap-1 text-brand-ink hover:text-brand-hover disabled:cursor-not-allowed disabled:text-warn"
                      >
                        <Eye aria-hidden="true" className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{a.file_name}</span>
                      </button>
                      {a.scan_status !== "clean" && (
                        <span className="text-[11px] text-warn">
                          {t.assetDetail.docs.scan[a.scan_status as "pending" | "infected" | "error"]}
                        </span>
                      )}
                      <span className="ms-auto shrink-0 text-xs tabular-nums text-muted">{formatDate(a.created_at, lang)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </aside>
      </div>

      {opts && (
        <>
          <ReplenishDialog item={dialog === "replenish" ? c : null} suppliers={opts.suppliers} fin={fin} t={t}
            onClose={() => setDialog(null)} onDone={(m) => { setToast(m); if (m.persisted) { setDialog(null); load(); } }} />
          <IssueDialog item={dialog === "issue" ? c : null} employees={opts.employees} departments={opts.departments} t={t}
            onClose={() => setDialog(null)} onDone={(m) => { setToast(m); if (m?.type === "success") { setDialog(null); load(); } }} />
          <EditConsumableDialog item={dialog === "edit" ? c : null} cats={(opts.categories ?? []).filter((x: any) => x.kind !== "asset")}
            companies={opts.companies} suppliers={opts.suppliers} locations={opts.locations} t={t}
            onClose={() => setDialog(null)} onDone={(m) => { setToast(m); if (m?.type === "success") { setDialog(null); load(); } }} />
        </>
      )}

      <Toast toast={toast} onDone={() => setToast(null)} />
    </div>
    </FeatureRoute>
  );
}

function StockStat({ label, value, small }: { label: string; value: string; small?: boolean }) {
  return (
    <div className="min-w-0 border-s border-line px-4">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={`mt-0.5 truncate font-display font-semibold tabular-nums text-fg ${small ? "text-[15px]" : "text-xl"}`}>{value}</dd>
    </div>
  );
}

function Info({ label, value, mono }: { label: string; value?: string | null; mono?: boolean }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className={`min-w-0 break-words text-fg ${mono && value ? "tag" : ""}`}>{value || "—"}</dd>
    </>
  );
}

function ConsumablePhoto({ attachments, t }: { attachments: any[]; t: Dict }) {
  const photo = attachments.filter((a) => a.kind === "consumable_photo").sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    (async () => {
      if (photo?.scan_status === "clean") {
        const { url } = await getAttachmentUrl(photo.storage_path, photo.file_name);
        setUrl(url);
      } else setUrl(null);
    })();
  }, [photo]);
  return (
    <section aria-labelledby="photo-title" className="ui-surface px-5 pb-5 pt-4">
      <h2 id="photo-title" className="mb-3 font-display text-[15px] font-semibold text-fg">{t.consumables.profile.photo}</h2>
      {url
        // مصدر الصورة رابط موقّت من تخزين خاص يتغيّر كل تحميل — next/image غير مناسب هنا
        // eslint-disable-next-line @next/next/no-img-element
        ? <img src={url} alt="" className="mx-auto max-h-56 rounded-lg border border-line object-contain" />
        : <div className="flex h-36 items-center justify-center rounded-lg border border-dashed border-line-strong text-muted"><PackageOpen aria-hidden="true" className="h-10 w-10" /></div>}
    </section>
  );
}

const TXN_TONE: Record<string, Tone> = { in: "ok", out: "info" };

function HistoryTable({ rows, fin, t, lang, empty }: { rows: any[]; fin: boolean; t: Dict; lang: Lang; empty: string }) {
  const th = t.consumables.hist;
  const lx = t.consumables.ledgerUx;
  if (!rows.length) return <EmptyState compact icon={History} title={empty} />;
  const typeLabel = (x: string) => x === "in" ? th.in : x === "out" ? th.out : th.adjust;
  const qtyLabel = (r: any) => {
    const q = Number(r.quantity);
    if (r.txn_type === "in") return `+${Math.abs(q)}`;
    if (r.txn_type === "out") return `−${Math.abs(q)}`;
    return q > 0 ? `+${q}` : q < 0 ? `−${Math.abs(q)}` : String(q);
  };
  return (
    <div tabIndex={0} className="overflow-x-auto border-t border-line">
      <table className="ui-table">
        <thead>
          <tr>
            <th>{th.date}</th><th>{th.type}</th><th>{th.quantity}</th><th>{th.balance}</th>
            <th>{lx.colReference}</th><th>{lx.colUser}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const refs: React.ReactNode[] = [];
            if (r.employee) refs.push(<span key="emp">{th.employee}: {r.employee.full_name_ar ?? r.employee.full_name}</span>);
            if (r.department) refs.push(<span key="dep">{th.department}: {r.department.name_ar ?? r.department.name}</span>);
            if (r.supplier) refs.push(<span key="sup">{th.supplier}: {r.supplier.name_ar ?? r.supplier.name}</span>);
            if (fin && r.invoice_number) refs.push(<span key="inv">{th.invoice}: <span className="tag">{r.invoice_number}</span></span>);
            if (fin && r.unit_cost != null) refs.push(<span key="uc">{th.unitCost}: {formatSAR(r.unit_cost, lang)}</span>);
            if (fin && r.total_cost != null) refs.push(<span key="tc">{th.totalCost}: {formatSAR(r.total_cost, lang)}</span>);
            if (r.reason) refs.push(<span key="note">{th.note}: {r.reason}</span>);
            return (
              <tr key={r.id}>
                <td className="whitespace-nowrap text-[13px] tabular-nums text-fg">{formatDateTime(r.created_at, lang)}</td>
                <td><StatusChip tone={TXN_TONE[r.txn_type] ?? "neu"}>{typeLabel(r.txn_type)}</StatusChip></td>
                <td><span dir="ltr" className={`font-semibold tabular-nums ${r.txn_type === "in" ? "text-ok" : "text-fg"}`}>{qtyLabel(r)}</span></td>
                <td className="font-medium tabular-nums text-fg">{r.balance_after}</td>
                <td className="min-w-[200px] text-xs text-fg-2">
                  {refs.length ? <div className="flex flex-col gap-0.5">{refs}</div> : <span className="text-muted">—</span>}
                </td>
                <td className="whitespace-nowrap">
                  {r.actor ? (
                    <span className="inline-flex items-center gap-2">
                      <span aria-hidden="true" className="ui-avatar h-6 w-6 text-[10px]">{initials(r.actor)}</span>
                      <span className="text-[13px] text-fg">{r.actor}</span>
                    </span>
                  ) : <span className="text-muted">—</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function initials(name: string) {
  return String(name).trim().split(/\s+/).slice(0, 2).map((part) => part.charAt(0)).join("");
}
