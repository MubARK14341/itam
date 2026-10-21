"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Camera, CameraOff, Keyboard, ScanLine, Loader2, Boxes, PackageOpen,
  Search, LogIn, LogOut, ArrowUpFromLine, ArrowDownToLine, ExternalLink, ClipboardList, Info,
  AlertTriangle, CircleAlert,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusChip } from "@/components/ui/status-chip";
import { Field, Select, inputClass } from "@/components/ui/form";
import { formatQtyUnit } from "@/lib/format";
import { ASSET_STATUS_TONE, toneChipClass, type Tone } from "@/lib/tone";
import { Toast, type ToastState } from "@/components/ui/toast";
import { IssueDialog } from "@/components/consumables/consumable-dialogs";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { useSession, canUseScan } from "@/lib/session";
import { useFeatureExposure } from "@/components/providers/feature-exposure-provider";
import {
  scanLookup, logScan, assetInLiveRequest, smartWarehouseScanMove,
  type ScanMatch, type ScanMode,
} from "@/lib/queries";

type Cta = "openItem" | "openConsumable" | "openRequests" | "issueConsumable" | null;
type ActionKind = "success" | "info" | "warn" | "blocked";
interface ActionState { kind: ActionKind; message: string; cta: Cta; }
interface PendingSmartScan { match: ScanMatch; value: string; action: "entry" | "exit"; operationId: string; }

const KIND_TONE: Record<ActionKind, Tone> = {
  success: "ok",
  info: "info",
  warn: "warn",
  blocked: "bad",
};

export function ScanConsole({
  employees, departments, warehouseId, locations, onLogged, historySlot,
}: {
  employees: any[]; departments: any[]; warehouseId: string | null; onLogged: () => void; historySlot?: React.ReactNode;
  locations: { id: string; name: string; name_ar?: string | null }[];
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { t, lang } = useAppPreferences();
  const { role } = useSession();
  const { isVisible } = useFeatureExposure();
  const ts = t.scan;
  const ops = canUseScan(role);
  // إظهار تدريجي: الإدخال/الإخراج من مستوى 30 — فوق شرط الدور (ops) لا بديلًا عنه.
  // رسائل الحجب/التحذير داخل العمليات نفسها لا تُمس (تحذيرات سلامة).
  const entryExitVisible = isVisible("scan.entryExit");
  const entryExitAllowed = ops && entryExitVisible;

  const scannerRef = useRef<any>(null);
  const manualRef = useRef<HTMLInputElement>(null);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);

  const [mode, setMode] = useState<ScanMode>("smart");
  // مرآة للـ mode داخل ref: دالة فك ترميز الكاميرا تُنشأ مرة واحدة وتغلق على قيمة قديمة —
  // القراءة من modeRef.current تضمن استخدام الوضع الحالي وقت المسح لا وقت تشغيل الكاميرا.
  const modeRef = useRef<ScanMode>("search");
  const [manual, setManual] = useState("");
  const [pendingValue, setPendingValue] = useState("");
  const [results, setResults] = useState<ScanMatch[]>([]);
  const [selected, setSelected] = useState<ScanMatch | null>(null);
  const [action, setAction] = useState<ActionState | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [lookupErr, setLookupErr] = useState(false);
  const [issueItem, setIssueItem] = useState<any | null>(null);
  const [toast, setToast] = useState<ToastState>(null);
  const [pendingSmart, setPendingSmart] = useState<PendingSmartScan | null>(null);
  const [destinationId, setDestinationId] = useState("");

  useEffect(() => { modeRef.current = mode; }, [mode]);

  useEffect(() => {
    return () => { void stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // بحث الشريط العلوي (/scan?q=…): يملأ حقل الإدخال اليدوي ويشغّل البحث نفسه في وضع «بحث فقط»
  // (قراءة فقط) — لا يطلق أبدًا نقلًا موجّهًا أو دخولًا/خروجًا. يُسجَّل كأي بحث يدوي عادي.
  // يُنفَّذ بعد مزامنة modeRef أعلاه حتى لا تُعيده إلى الوضع الافتراضي قبل بدء البحث.
  const topbarQuery = (searchParams.get("q") ?? "").trim();
  const lastTopbarQuery = useRef<string | null>(null);
  useEffect(() => {
    if (!topbarQuery) { lastTopbarQuery.current = null; return; }
    if (lastTopbarQuery.current === topbarQuery) return;
    lastTopbarQuery.current = topbarQuery;
    modeRef.current = "search";
    setMode("search");
    setManual(topbarQuery);
    void runLookup(topbarQuery);
    // نزيل q من العنوان بعد التنفيذ كي لا يُعاد البحث ويُسجَّل مرة أخرى عند تحديث الصفحة.
    router.replace("/scan", { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topbarQuery]);

  function changeMode(m: ScanMode) {
    if ((m === "entry" || m === "exit") && !entryExitAllowed) return;
    setMode(m);
    resetOutcome();
  }
  function resetOutcome() {
    setResults([]); setSelected(null); setAction(null); setNotFound(false); setLookupErr(false);
  }

  async function stop() {
    const s = scannerRef.current;
    if (s) {
      try { await s.stop(); await s.clear(); } catch { /* ignore */ }
      scannerRef.current = null;
    }
    setScanning(false);
  }

  async function start() {
    setCameraError(null);
    setBusy(true);
    try {
      const { Html5Qrcode } = await import("html5-qrcode");
      const scanner = new Html5Qrcode("qr-reader");
      scannerRef.current = scanner;
      await scanner.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 240, height: 240 } },
        async (decoded: string) => { await stop(); await runLookup(decoded); },
        () => { /* per-frame decode errors: ignore */ }
      );
      setScanning(true);
    } catch {
      setCameraError(ts.cameraError);
    } finally {
      setBusy(false);
    }
  }

  async function runLookup(raw: string) {
    const value = raw.trim();
    if (!value) return;
    const activeMode = modeRef.current; // الوضع الحالي وقت المسح (لا وقت تشغيل الكاميرا)
    setBusy(true); setCameraError(null); resetOutcome(); setPendingValue(value);
    let matches: ScanMatch[] = [];
    try {
      matches = await scanLookup(value);
    } catch (e: any) {
      setBusy(false); setLookupErr(true);
      if (ops) await logScan({ mode: activeMode === "smart" ? "search" : activeMode, result: "error", itemKind: "unknown", scannedValue: value, matchedBy: "manual", errorCode: "lookup_error", notes: String(e?.message ?? e).slice(0, 200) });
      onLogged();
      return;
    }
    setBusy(false);
    if (matches.length === 0) {
      setNotFound(true);
      if (ops) await logScan({ mode: activeMode === "smart" ? "search" : activeMode, result: "not_found", itemKind: "unknown", scannedValue: value, matchedBy: "manual", errorCode: "not_found" });
      onLogged();
      return;
    }
    if (matches.length === 1) { await processMatch(matches[0], value); return; }
    setResults(matches); // أكثر من نتيجة → اعرض قائمة للاختيار
  }

  async function processMatch(m: ScanMatch, value: string) {
    setResults([]); setSelected(m); setNotFound(false); setLookupErr(false);
    const activeMode = modeRef.current;
    if (activeMode === "smart") return proposeSmartMove(m, value);
    if (activeMode === "search") return doSearch(m, value);
    if (activeMode === "entry") return doEntry(m, value);
    return doExit(m, value);
  }

  const idFields = (m: ScanMatch) => ({
    itemKind: m.type, assetId: m.type === "asset" ? m.id : null, consumableId: m.type === "consumable" ? m.id : null,
  });

  async function proposeSmartMove(m: ScanMatch, value: string) {
    if (!ops) return doSearch(m, value);
    if (m.type !== "asset") return doSearch(m, value);
    if (!warehouseId || !["available", "reserved"].includes(m.status ?? "")) {
      if (ops) await logScan({ mode: "search", result: "blocked", ...idFields(m), scannedValue: value, matchedBy: m.matchedBy, errorCode: "asset_state_blocks_movement" });
      setAction({ kind: "blocked", message: ts.smartBlocked, cta: "openItem" });
      onLogged();
      return;
    }
    const action = m.location?.id === warehouseId ? "exit" : "entry";
    setDestinationId("");
    setPendingSmart({ match: m, value, action, operationId: crypto.randomUUID() });
    setAction({ kind: "info", message: action === "exit" ? ts.smartSuggestExit : ts.smartSuggestEntry, cta: null });
  }

  async function confirmSmartMove() {
    if (!pendingSmart || !warehouseId || (pendingSmart.action === "exit" && !destinationId)) return;
    setBusy(true);
    const result = await smartWarehouseScanMove({
      assetId: pendingSmart.match.id,
      action: pendingSmart.action,
      warehouseId,
      operationId: pendingSmart.operationId,
      destinationId: pendingSmart.action === "exit" ? destinationId : null,
    });
    setBusy(false);
    if (!result.ok) {
      setAction({ kind: "blocked", message: ts.smartBlocked, cta: "openItem" });
      if (ops) await logScan({ mode: pendingSmart.action, result: "blocked", ...idFields(pendingSmart.match), scannedValue: pendingSmart.value, matchedBy: pendingSmart.match.matchedBy, errorCode: result.error ?? "smart_move_failed" });
    } else {
      setAction({ kind: "success", message: pendingSmart.action === "entry" ? ts.smartEntryComplete : ts.smartExitComplete, cta: "openItem" });
      if (ops) await logScan({ mode: pendingSmart.action, result: "found", ...idFields(pendingSmart.match), scannedValue: pendingSmart.value, matchedBy: pendingSmart.match.matchedBy, locationId: pendingSmart.action === "entry" ? warehouseId : destinationId, notes: "smart_confirmed" });
    }
    setPendingSmart(null);
    onLogged();
  }

  async function doSearch(m: ScanMatch, value: string) {
    if (ops) await logScan({ mode: "search", result: "found", ...idFields(m), scannedValue: value, matchedBy: m.matchedBy });
    setAction({ kind: "info", message: m.type === "asset" ? ts.assetFound : ts.consumableFound, cta: "openItem" });
    onLogged();
  }

  async function doEntry(m: ScanMatch, value: string) {
    if (m.type === "asset") {
      const s = m.status;
      if (s === "reserved") {
        await logScan({ mode: "entry", result: "blocked", ...idFields(m), scannedValue: value, matchedBy: m.matchedBy, errorCode: "asset_out_return_flow" });
        setAction({ kind: "warn", message: ts.assetReserved, cta: "openItem" });
      } else if (s === "in_maintenance") {
        await logScan({ mode: "entry", result: "found", ...idFields(m), scannedValue: value, matchedBy: m.matchedBy, locationId: warehouseId, notes: "entry_maintenance" });
        setAction({ kind: "warn", message: ts.assetInMaintenance, cta: "openItem" });
      } else {
        await logScan({ mode: "entry", result: "found", ...idFields(m), scannedValue: value, matchedBy: m.matchedBy, locationId: warehouseId });
        setAction({ kind: "success", message: ts.entryRecorded, cta: "openItem" });
      }
    } else {
      // مستهلك: لا زيادة تلقائية — نسجّل الدخول ونوجّه إلى «توريد»
      await logScan({ mode: "entry", result: "found", ...idFields(m), scannedValue: value, matchedBy: m.matchedBy, locationId: warehouseId, notes: "consumable_supply" });
      setAction({ kind: "info", message: ts.consumableEntryHint, cta: "openConsumable" });
    }
    onLogged();
  }

  async function doExit(m: ScanMatch, value: string) {
    if (m.type === "asset") {
      const inReq = await assetInLiveRequest(m.id).catch(() => false);
      if (inReq) {
        await logScan({ mode: "exit", result: "blocked", ...idFields(m), scannedValue: value, matchedBy: m.matchedBy, errorCode: "asset_in_request" });
        setAction({ kind: "blocked", message: ts.assetInRequest, cta: "openRequests" });
      } else {
        await logScan({ mode: "exit", result: "found", ...idFields(m), scannedValue: value, matchedBy: m.matchedBy, notes: "manual_exit" });
        setAction({ kind: "info", message: `${ts.exitRecorded} ${ts.useRequestDelivery}`, cta: "openRequests" });
      }
      onLogged();
    } else {
      // مستهلك: لا نقص كمية بلا كمية+سبب — نفتح dialog الصرف الآمن الموجود
      setAction({ kind: "info", message: ts.consumableExitHint, cta: "issueConsumable" });
    }
  }

  // بعد نجاح صرف المستهلك عبر IssueDialog → سجّل exit في scan_logs
  async function afterIssue(m: ToastState) {
    setIssueItem(null);
    if (m && m.type === "success" && selected && selected.type === "consumable") {
      await logScan({ mode: "exit", result: "found", itemKind: "consumable", consumableId: selected.id, scannedValue: pendingValue, matchedBy: selected.matchedBy, notes: "issue_via_scan" });
      onLogged();
    }
    setToast(m);
  }

  function runCta(cta: Cta) {
    if (!selected) return;
    if (cta === "openItem") router.push(selected.type === "asset" ? `/assets/${selected.id}` : `/consumables/${selected.id}`);
    else if (cta === "openConsumable") router.push(`/consumables/${selected.id}`);
    else if (cta === "openRequests") router.push("/requests");
    else if (cta === "issueConsumable") setIssueItem({ id: selected.id, name: selected.label, quantity_on_hand: selected.quantity ?? 0, unit: selected.unit ?? "" });
  }

  function ctaButton(cta: Cta) {
    if (!cta) return null;
    if (cta === "openItem") return <Button size="sm" variant="outline" onClick={() => runCta(cta)}><ExternalLink aria-hidden="true" className="h-4 w-4" />{ts.openItem}</Button>;
    if (cta === "openConsumable") return <Button size="sm" onClick={() => runCta(cta)}><ArrowDownToLine aria-hidden="true" className="h-4 w-4" />{ts.addSupply}</Button>;
    if (cta === "openRequests") return <Button size="sm" variant="outline" onClick={() => runCta(cta)}><ClipboardList aria-hidden="true" className="h-4 w-4" />{ts.openRequests}</Button>;
    if (cta === "issueConsumable") return <Button size="sm" onClick={() => runCta(cta)}><ArrowUpFromLine aria-hidden="true" className="h-4 w-4" />{ts.issueBtn}</Button>;
    return null;
  }

  function submitManual(e: React.FormEvent) {
    e.preventDefault();
    const v = manual.trim();
    if (!v) return;
    void runLookup(v);           // البحث يستخدم القيمة المُلتقطة v (لا حالة manual)
    setManual("");               // نظّف الحقل وأعد التركيز لتسهيل المسح التالي
    manualRef.current?.focus();
  }

  function scanAnother() {
    resetOutcome();
    manualRef.current?.focus();
  }

  const locName = (m: ScanMatch) => m.location ? (lang === "ar" ? (m.location.name_ar ?? m.location.name) : m.location.name) : null;
  const statusLabel = (m: ScanMatch) => (m.status ? (t.status as Record<string, string>)[m.status] ?? m.status : null);

  const MODES: { key: ScanMode; label: string; icon: typeof Search; opsOnly: boolean }[] = [
    { key: "smart", label: ts.modes.smart, icon: ScanLine, opsOnly: false },
    { key: "search", label: ts.modes.search, icon: Search, opsOnly: false },
    { key: "entry", label: ts.modes.entry, icon: LogIn, opsOnly: true },
    { key: "exit", label: ts.modes.exit, icon: LogOut, opsOnly: true },
  ];
  const modeHint = mode === "smart" ? ts.smartModeHint : mode === "search" ? ts.searchModeHint : mode === "entry" ? ts.entryModeHint : ts.exitModeHint;

  const hasOutcome = notFound || lookupErr || results.length > 0 || !!selected;

  return (
    <>
      {/* شاشات كبيرة: عمودان — (الماسح: الوضع + الكاميرا + الإدخال) | (نتيجة آخر مسح)؛ السجل أسفلهما بعرض كامل. عمود واحد على الجوال. */}
      <div className="space-y-6">
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(280px,320px)] xl:items-start">
          {/* الماسح */}
          <Card>
            <section aria-labelledby="scan-scanner-title" className="flex flex-col gap-5 p-5 sm:p-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 id="scan-scanner-title" className="font-display text-[17px] font-semibold text-fg">{ts.scannerTitle}</h2>
                {/* إظهار تدريجي: تحت مستوى 30 يختفي زرا الإدخال/الإخراج كليًا (وضع البحث يبقى).
                    عند 100% يعود السلوك الحالي تمامًا: الأزرار ظاهرة ومعطّلة لغير التشغيليين. */}
                <div role="group" aria-label={ts.modeLabel} className="flex max-w-full items-center gap-4 overflow-x-auto">
                  {MODES.filter((mo) => !mo.opsOnly || entryExitVisible).map((mo) => {
                    const disabled = mo.opsOnly && !ops;
                    return (
                      <button
                        key={mo.key}
                        type="button"
                        onClick={() => changeMode(mo.key)}
                        disabled={disabled}
                        aria-pressed={mode === mo.key}
                        title={disabled ? ts.onlyOps : undefined}
                        className={`inline-flex min-h-11 shrink-0 items-center gap-1.5 border-b-[3px] px-0.5 text-[13px] disabled:cursor-not-allowed disabled:opacity-45 ${mode === mo.key ? "border-brand font-semibold text-fg" : "border-transparent text-muted hover:text-fg"}`}
                      >
                        <mo.icon aria-hidden="true" className="h-[15px] w-[15px]" />
                        {mo.label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <p className="flex items-start gap-2 text-[12.5px] text-muted">
                <Info aria-hidden="true" className="mt-[3px] h-3.5 w-3.5 shrink-0" />
                <span>{modeHint}{!ops && entryExitVisible && <span className="ms-1">· {ts.onlyOps}</span>}</span>
              </p>

              {/* الكاميرا */}
              <div
                role="region"
                aria-label={ts.cameraRegion}
                className="relative flex aspect-[4/3] w-full items-center justify-center overflow-hidden rounded-xl bg-[rgb(var(--hero))] text-[rgb(var(--hero-muted))] sm:aspect-[16/7]"
              >
                <div id="qr-reader" className="h-full w-full [&_video]:h-full [&_video]:w-full [&_video]:object-cover" />
                {!scanning && !busy && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 text-center">
                    <CameraOff aria-hidden="true" className="h-8 w-8" strokeWidth={1.6} />
                    <span className="text-[13px]">{ts.cameraOff}</span>
                    <Button variant="outline" onClick={start} disabled={busy} className="mt-3"><Camera aria-hidden="true" className="h-4 w-4" />{ts.startCamera}</Button>
                  </div>
                )}
                {busy && !scanning && <Loader2 aria-hidden="true" className="absolute h-8 w-8 animate-spin" />}
                {scanning && (
                  <Button size="sm" variant="outline" onClick={stop} className="absolute end-2.5 top-2.5">
                    <CameraOff aria-hidden="true" className="h-4 w-4" />{ts.stop}
                  </Button>
                )}
              </div>
              {busy && !scanning && <p className="sr-only" role="status">{ts.starting}</p>}
              {cameraError && <div role="alert" className="rounded-control bg-bad-soft px-4 py-3 text-[13px] text-bad">{cameraError}</div>}

              {/* إدخال يدوي */}
              <div className="border-t border-line pt-5">
                <label htmlFor="scan-manual" className="ui-label flex items-center gap-1.5">
                  <Keyboard aria-hidden="true" className="h-[15px] w-[15px]" /> {ts.manualTitle}
                </label>
                <form onSubmit={submitManual} className="flex flex-col items-start gap-3 sm:items-end">
                  <input id="scan-manual" ref={manualRef} autoFocus className={`${inputClass} font-mono`} value={manual} onChange={(e) => setManual(e.target.value)}
                    placeholder={ts.manualPlaceholder} aria-label={ts.manualPlaceholder} dir="ltr" />
                  <Button type="submit" disabled={busy || !manual.trim()}><Search aria-hidden="true" className="h-4 w-4" />{ts.searchBtn}</Button>
                </form>
                <p className="ui-hint">{ts.manualHint}</p>
              </div>
            </section>
          </Card>

          {/* نتيجة آخر مسح */}
          <Card className="min-h-[22rem] overflow-hidden">
            <section aria-labelledby="scan-result-title" aria-live="polite">
              <div className="flex flex-wrap items-center justify-between gap-3 px-5 pb-3 pt-6">
                <h2 id="scan-result-title" className="font-display text-[17px] font-semibold text-fg">{ts.lastResultTitle}</h2>
                {hasOutcome && (
                  <span className="inline-flex items-center gap-2 text-[12.5px] text-muted">
                    <span>{MODES.find((mo) => mo.key === mode)?.label}</span>
                    <Button size="sm" variant="ghost" onClick={resetOutcome}>{ts.clearResult}</Button>
                  </span>
                )}
              </div>

              {/* قبل أي مسح */}
              {!hasOutcome && (
                busy
                  ? <div className="flex justify-center px-5 py-16"><Loader2 aria-hidden="true" className="h-6 w-6 animate-spin text-muted" /></div>
                  : <EmptyState icon={ScanLine} title={ts.lastResultEmpty} />
              )}

              {/* لا نتيجة مطابقة */}
              {notFound && (
                <div className="flex flex-col gap-4 px-5 py-5">
                  <div className="flex items-start gap-3.5">
                    <span className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${toneChipClass("warn")}`}>
                      <AlertTriangle aria-hidden="true" className="h-5 w-5" />
                    </span>
                    <div className="min-w-0">
                      <h3 className="font-display text-lg font-semibold text-fg">{ts.unknown}</h3>
                      <p className="mt-1 text-[13px] text-muted">{ts.nextActionScan}</p>
                    </div>
                  </div>
                  <dl className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-y-2.5 rounded-xl border border-line bg-surface-2 px-4 py-3.5 text-[13.5px]">
                    <dt className="text-muted">{ts.scannedValue}</dt>
                    <dd><bdi dir="ltr" className="font-mono font-medium">{pendingValue}</bdi></dd>
                    <dt className="text-muted">{ts.modeField}</dt>
                    <dd>{MODES.find((mo) => mo.key === mode)?.label}</dd>
                  </dl>
                  <div><Button variant="outline" onClick={scanAnother}>{ts.scanAnother}</Button></div>
                </div>
              )}

              {/* فشل البحث (خطأ اتصال/خادم) — رسالة مميّزة عن «لا نتيجة» */}
              {lookupErr && (
                <div className="px-5 py-5">
                  <div role="alert" className="flex items-start gap-2.5 rounded-xl bg-bad-soft px-4 py-3 text-[13.5px] text-bad">
                    <CircleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{ts.lookupErrorMsg}</span>
                  </div>
                </div>
              )}

              {/* أكثر من نتيجة → اختيار */}
              {results.length > 1 && (
                <div>
                  <h3 className="px-5 pb-2 pt-4 text-[13px] font-semibold text-muted">{ts.resultsTitle}</h3>
                  <ul className="border-t border-line">
                    {results.map((m) => (
                      <li key={`${m.type}-${m.id}`} className="border-b border-line last:border-b-0">
                        <button type="button" onClick={() => processMatch(m, pendingValue)} className="flex min-h-12 w-full items-center gap-3 px-5 py-2.5 text-start transition-colors hover:bg-surface-2">
                          {m.type === "asset" ? <Boxes aria-hidden="true" className="h-4 w-4 shrink-0 text-brand-ink" /> : <PackageOpen aria-hidden="true" className="h-4 w-4 shrink-0 text-brand-ink" />}
                          <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
                            <bdi dir="ltr" className="font-mono">{m.label}</bdi>{m.sub && <span className="text-muted"> · {m.sub}</span>}
                          </span>
                          <StatusChip tone="neu" dot={false} size="sm">{m.type === "asset" ? ts.assetType : ts.consumableType}</StatusChip>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* بطاقة النتيجة + الإجراء */}
              {selected && (
                <div className="flex flex-col gap-3.5 px-5 pb-5 pt-4">
                  <div className="flex items-start gap-3.5">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted">
                        <StatusChip tone="neu" dot={false} size="sm">
                          {selected.type === "asset" ? <Boxes aria-hidden="true" className="h-3.5 w-3.5" /> : <PackageOpen aria-hidden="true" className="h-3.5 w-3.5" />}
                          {selected.type === "asset" ? ts.assetType : ts.consumableType}
                        </StatusChip>
                        <span>{ts.matchedBy}: {(ts.matchedByLabels as Record<string, string>)[selected.matchedBy] ?? selected.matchedBy}</span>
                      </div>
                      {selected.sub ? (
                        <>
                          <p className="mt-2"><bdi dir="ltr" className="font-mono text-sm font-medium text-brand-ink">{selected.label}</bdi></p>
                          <h3 className="mt-0.5 font-display text-xl font-semibold leading-snug text-fg">{selected.sub}</h3>
                        </>
                      ) : (
                        <h3 className="mt-2 font-display text-xl font-semibold leading-snug text-fg">{selected.label}</h3>
                      )}
                    </div>
                    {selected.status && statusLabel(selected) && (
                      <StatusChip tone={ASSET_STATUS_TONE[selected.status]}>{statusLabel(selected)}</StatusChip>
                    )}
                  </div>

                  <dl className="grid grid-cols-2 gap-x-5 gap-y-3 border-y border-line py-3 text-[13.5px]">
                    {locName(selected) && (<div><dt className="text-xs text-muted">{ts.locationLabel}</dt><dd className="mt-0.5 text-fg">{locName(selected)}</dd></div>)}
                    {selected.company?.name && (<div><dt className="text-xs text-muted">{ts.companyLabel}</dt><dd className="mt-0.5 text-fg">{selected.company.name}</dd></div>)}
                    {false && selected?.pool && (<div><dt className="text-xs text-muted">{t.pools.field}</dt><dd className="mt-0.5 text-fg">{lang === "ar" ? (selected?.pool?.name_ar ?? selected?.pool?.name) : selected?.pool?.name}</dd></div>)}
                    {selected.type === "consumable" && selected.quantity != null && (<div><dt className="text-xs text-muted">{ts.quantityLabel}</dt><dd className="mt-0.5 tabular-nums text-fg">{formatQtyUnit(selected.quantity, selected.unit, t.consumables.form.units)}</dd></div>)}
                    <div><dt className="text-xs text-muted">{ts.scannedValue}</dt><dd className="mt-0.5"><bdi dir="ltr" className="font-mono text-fg">{pendingValue}</bdi></dd></div>
                  </dl>

                  {action && (
                    <div className={`rounded-xl px-3.5 py-3 text-[13.5px] ${toneChipClass(KIND_TONE[action.kind])}`}>
                      <p className="font-medium">{action.message}</p>
                      {action.cta && <div className="mt-2.5 flex flex-wrap gap-2">{ctaButton(action.cta)}</div>}
                    </div>
                  )}
                </div>
              )}
            </section>
          </Card>
        </div>

        {/* سجل المسح (يُمرَّر من الصفحة — للأدوار التشغيلية فقط) */}
        {historySlot}
      </div>

      {/* dialog صرف المستهلك (يُعاد استخدامه من نظام المستهلكات — نقص آمن بلا رصيد سالب) */}
      <IssueDialog item={issueItem} employees={employees} departments={departments} t={t}
        onClose={() => setIssueItem(null)} onDone={afterIssue} />

      <Dialog open={!!pendingSmart} onClose={() => { if (!busy) setPendingSmart(null); }} title={ts.smartConfirmTitle}
        footer={<><Button variant="outline" disabled={busy} onClick={() => setPendingSmart(null)}>{t.common.cancel}</Button><Button onClick={() => void confirmSmartMove()} disabled={busy || (pendingSmart?.action === "exit" && !destinationId)}>{pendingSmart?.action === "entry" ? ts.smartConfirmEntry : ts.smartConfirmExit}</Button></>}>
        <p className="text-sm text-fg-2"><bdi dir="ltr" className="font-mono">{pendingSmart?.match.label}</bdi></p>
        <p className="mt-2 text-sm font-semibold text-fg">{pendingSmart?.action === "entry" ? ts.smartSuggestEntry : ts.smartSuggestExit}</p>
        <p className="mt-2 text-xs text-muted">{ts.smartConfirmHint}</p>
        {pendingSmart?.action === "exit" && <div className="mt-4"><Field label={ts.destination} required><Select label={ts.destination} value={destinationId} onChange={setDestinationId} disabled={busy} required placeholder={ts.chooseDestination} options={locations.filter((location) => location.id !== warehouseId).map((location) => ({ value: location.id, label: lang === "ar" ? (location.name_ar ?? location.name) : location.name }))} /></Field></div>}
      </Dialog>

      <Toast toast={toast} onDone={() => setToast(null)} />
    </>
  );
}
