"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Plus, ArrowDownToLine, ArrowUpFromLine, Pencil, Eye, PackageOpen, SearchX, TriangleAlert } from "lucide-react";
import { Button, buttonClass } from "@/components/ui/button";
import { FilterChip } from "@/components/ui/filter-chip";
import { StatusChip } from "@/components/ui/status-chip";
import { EmptyState } from "@/components/ui/empty-state";
import { Dialog } from "@/components/ui/dialog";
import { Field, SearchInput, Select, inputClass } from "@/components/ui/form";
import { Toast, type ToastState } from "@/components/ui/toast";
import { PageHeader } from "@/components/ui/page-header";
import { EquipmentPhoto } from "@/components/assets/equipment-photo";
import { listConsumablesPage, createConsumable, getFormOptions } from "@/lib/queries";
import type { AscTextCursor } from "@/lib/pagination";
import { ReplenishDialog, IssueDialog, EditConsumableDialog } from "@/components/consumables/consumable-dialogs";
import { useSession, canManageConsumables, canSeeFinancial, useCan } from "@/lib/session";
import { useFeatureExposure } from "@/components/providers/feature-exposure-provider";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import type { Dict } from "@/lib/i18n";
import { parseStrictDecimal, parseStrictInteger } from "@/lib/numeric-validation";
import {
  beginOperationalListRequest,
  completeOperationalListRequest,
  createOperationalListRequestGate,
} from "@/lib/operational-list-request-gate";

const UNIT_KEYS = ["piece", "box", "ream", "set"] as const;
const isAtOrBelowReorder = (row: { quantity_on_hand?: number | null; reorder_level?: number | null }) =>
  Number(row.quantity_on_hand) <= Number(row.reorder_level);
const isOut = (row: { quantity_on_hand?: number | null }) => Number(row.quantity_on_hand) === 0;

/**
 * لوحة إدارة المستهلكات — مكوّن قابل لإعادة الاستخدام.
 * تُستخدم في صفحة /consumables (مع العنوان) وداخل تبويب «المستهلكات» في صفحة /assets (بدون عنوان).
 * كل منطق الجلب/الكتابة يبقى في @/lib/queries (مصدر واحد) — لا تكرار ولا تغيير قاعدة بيانات.
 */
export function ConsumablesPanel({ embedded = false }: { embedded?: boolean }) {
  const { role } = useSession();
  const { t } = useAppPreferences();
  const { isVisible } = useFeatureExposure();
  const can = useCan();
  const write = canManageConsumables(role);
  const catalogWrite = can("consumable.manage");
  const fin = canSeeFinancial(role);
  // إظهار تدريجي (فوق شرط الدور write): صرف/توريد من 30، إضافة/تعديل من 50.
  // شارات المخزون (نفد/منخفض) لا تُربط بالإظهار — تحذيرات تشغيلية دائمة.
  const expIssue = isVisible("consumables.issue");
  const expSupply = isVisible("consumables.supply");
  const expAddEdit = isVisible("consumables.addEdit");
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [cursor, setCursor] = useState<AscTextCursor | null>(null);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState("");
  // فلتر النواقص (النواقص أولًا): "" الكل · "out" النافد · "below" تحت حد الطلب (يشمل النافد).
  const [companyFilter, setCompanyFilter] = useState("");
  // قائمة عمل (?view=) — تُقرأ فقط في الصفحة المستقلة /consumables (لا داخل تبويب الأصول).
  const [belowReorderOnly, setBelowReorderOnly] = useState(false);
  // شرائح المخزون (Ledger) — تصفية محلية للصفوف المحمّلة فقط: "" الكل · "low" منخفض · "out" نافد.
  const [stockFilter, setStockFilter] = useState<"" | "low" | "out">("");
  const [toast, setToast] = useState<ToastState>(null);
  const [replenishFor, setReplenishFor] = useState<any | null>(null);
  const [issueFor, setIssueFor] = useState<any | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [editFor, setEditFor] = useState<any | null>(null);
  const [cats, setCats] = useState<any[]>([]);
  const [companies, setCompanies] = useState<{ id: string; name: string }[]>([]);
  const [opts, setOpts] = useState<any>(null);
  const listRequestGate = useRef(createOperationalListRequestGate());

  async function load(reset = true) {
    const generation = beginOperationalListRequest(listRequestGate.current, reset, cursor !== null);
    if (generation === null) return;
    if (reset) setLoading(true); else setLoadingMore(true);
    const page = await listConsumablesPage({
      cursor: reset ? null : cursor,
      includeFinancial: fin,
      filters: { q, companyId: companyFilter },
    });
    if (!completeOperationalListRequest(listRequestGate.current, generation)) return;
    const { rows, error } = page;
    if (error) setToast({ type: "error", message: t.consumables.loadError + error });
    setRows((previous) => reset ? rows : [...previous, ...rows]);
    setCursor(page.nextCursor);
    if (page.total != null) setTotal(page.total);
    setLoading(false); setLoadingMore(false);
  }
  useEffect(() => {
    getFormOptions().then((o) => {
      setOpts(o);
      setCats(o.categories.filter((c: any) => c.kind !== "asset"));
      setCompanies(o.companies ?? []);
    });
  }, []);
  const lastLoadQuery = useRef<string | null>(null);
  useEffect(() => {
    // تأخير 250ms فقط عند كتابة البحث؛ التحميل الأول وتغيير الفلاتر فوريان.
    const typing = lastLoadQuery.current !== null && lastLoadQuery.current !== q;
    lastLoadQuery.current = q;
    const timer = window.setTimeout(() => { void load(true); }, typing ? 250 : 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, companyFilter, fin]);

  useEffect(() => {
    if (embedded) return;
    try {
      setBelowReorderOnly(new URLSearchParams(window.location.search).get("view") === "below_reorder");
    } catch { /* غير حرج */ }
  }, [embedded]);

  const clearView = () => {
    setBelowReorderOnly(false);
    try { window.history.replaceState({}, "", "/consumables"); } catch { /* غير حرج */ }
  };

  const baseFiltered = useMemo(() => rows.filter((r) => {
    // قائمة العمل أولًا: نفس شرط كرت اللوحة حرفيًا — الرقم يطابق القائمة.
    if (belowReorderOnly && !isAtOrBelowReorder(r)) return false;
    if (companyFilter && r.company_id !== companyFilter) return false;
    if (q && !`${r.name} ${r.sku ?? ""} ${r.brand ?? ""}`.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  }), [rows, q, companyFilter, belowReorderOnly]);
  const stockCounts = useMemo(() => {
    let out = 0, low = 0;
    for (const r of baseFiltered) {
      if (isOut(r)) out++;
      else if (isAtOrBelowReorder(r)) low++;
    }
    return { out, low };
  }, [baseFiltered]);
  const filtered = useMemo(() => baseFiltered.filter((r) => {
    if (stockFilter === "out") return isOut(r);
    if (stockFilter === "low") return !isOut(r) && isAtOrBelowReorder(r);
    return true;
  }), [baseFiltered, stockFilter]);

  // عدّادات النواقص (نفس شرط التنبيهات) — للملخّص أعلى اللوحة.
  const lx = t.consumables.ledgerUx;
  const h = t.consumables.headers;
  const anyLocalFilter = !!(q || companyFilter || stockFilter);
  return (
    <div>
      {!embedded && (
        <PageHeader
          title={t.consumables.title}
          description={loading ? t.consumables.loading : `${filtered.length} / ${total} ${t.consumables.countItems}`}
          actions={catalogWrite && expAddEdit ? <Button onClick={() => setAddOpen(true)}><Plus aria-hidden="true" className="h-4 w-4" />{t.consumables.add}</Button> : undefined}
        />
      )}

      {/* شعار قائمة العمل — من كروت التنبيهات (?view=). العدد يطابق الكرت (نفس الشرط). */}
      {belowReorderOnly && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-card border border-line bg-warn-soft px-4 py-3">
          <span className="inline-flex items-center gap-2 text-sm font-semibold text-warn">
            <TriangleAlert aria-hidden="true" className="h-4 w-4" />{t.dashboard.consumableRisk.title}
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={clearView} className="text-brand-ink">
            {t.dashboard.consumableRisk.showAll}
          </Button>
        </div>
      )}

      <section aria-label={t.consumables.title} className="ui-surface overflow-hidden">
        {/* شريط أدوات مضغوط: بحث + شركة + شرائح المخزون (تصفية محلية) */}
        <div className="flex flex-wrap items-center gap-2.5 border-b border-line px-3.5 py-3">
          <SearchInput label={t.consumables.searchPlaceholder} clearLabel={t.common.clearSearch}
            value={q} onChange={(e) => setQ(e.target.value)} onClear={() => setQ("")}
            placeholder={t.consumables.searchPlaceholder} containerClassName="w-full sm:w-72" />
          <div className="w-full sm:w-48">
            <Select value={companyFilter} onChange={setCompanyFilter} placeholder={t.consumables.allCompanies}
              options={companies.map((c) => ({ value: c.id, label: c.name }))} />
          </div>
          <div role="group" aria-label={lx.stockFilterLabel} className="flex flex-wrap items-center gap-2">
            <FilterChip pressed={stockFilter === "out"} count={loading ? undefined : stockCounts.out} onClick={() => setStockFilter((cur) => (cur === "out" ? "" : "out"))}>
              <span aria-hidden="true" className="h-2 w-2 rounded-full bg-bad" />{t.consumables.out}
            </FilterChip>
            <FilterChip pressed={stockFilter === "low"} count={loading ? undefined : stockCounts.low} onClick={() => setStockFilter((cur) => (cur === "low" ? "" : "low"))}>
              <span aria-hidden="true" className="h-2 w-2 rounded-full bg-warn" />{t.consumables.low}
            </FilterChip>
          </div>
          <div className="flex-1" />
          {embedded && catalogWrite && expAddEdit && (
            <Button onClick={() => setAddOpen(true)}><Plus aria-hidden="true" className="h-4 w-4" />{t.consumables.add}</Button>
          )}
        </div>

        <div tabIndex={0} className="overflow-x-auto">
          <table className="ui-table">
            <thead>
              <tr>
                <th>{h.name}</th><th>{h.sku}</th><th>{h.category}</th><th>{h.company}</th>
                <th>{h.stock}</th><th>{h.reorder}</th><th>{h.status}</th><th>{h.move}</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={`sk-${i}`} className="animate-pulse"><td colSpan={8}><div className="h-4 w-full rounded bg-sunk" /></td></tr>
                ))
              ) : filtered.length === 0 ? (
                <tr><td colSpan={8}>
                  <EmptyState
                    compact
                    icon={anyLocalFilter ? SearchX : PackageOpen}
                    title={t.consumables.empty}
                    action={stockFilter ? <Button variant="outline" size="sm" onClick={() => setStockFilter("")}>{t.common.clearFilters}</Button> : undefined}
                  />
                </td></tr>
              ) : filtered.map((r) => {
                const out = Number(r.quantity_on_hand) === 0;
                const low = r.quantity_on_hand <= r.reorder_level;
                const unitLabel = (t.consumables.form.units as Record<string, string>)[r.unit] ?? r.unit;
                return (
                  <tr key={r.id}>
                    <td className="min-w-[220px]">
                      <div className="flex items-center gap-3">
                        <EquipmentPhoto templateId="consumable" />
                        <div className="min-w-0">
                          <Link href={`/consumables/${r.id}`} prefetch={false} className="font-semibold text-fg hover:text-brand-ink">{r.name}</Link>
                          {r.brand && <span className="block text-xs text-muted">{r.brand}</span>}
                        </div>
                      </div>
                    </td>
                    <td className="whitespace-nowrap">{r.sku ? <span className="tag text-fg-2">{r.sku}</span> : <span className="text-muted">—</span>}</td>
                    <td className="text-fg-2">{r.category?.name_ar ?? r.category?.name ?? "—"}</td>
                    <td className="text-fg-2">{r.company?.name ?? "—"}</td>
                    <td className="whitespace-nowrap">
                      <span className={`font-semibold tabular-nums ${out ? "text-bad" : low ? "text-warn" : "text-fg"}`}>{r.quantity_on_hand}</span>
                      <span className="text-xs text-muted"> {unitLabel}</span>
                    </td>
                    <td className="tabular-nums text-fg-2">{r.reorder_level}</td>
                    <td>
                      <StatusChip tone={out ? "bad" : low ? "warn" : "ok"}>{out ? t.consumables.out : low ? t.consumables.low : t.consumables.good}</StatusChip>
                    </td>
                    <td>
                      {write && (expSupply || expIssue || expAddEdit) ? (
                        <div className="flex gap-1">
                          {expSupply && <Button size="sm" variant="outline" onClick={() => setReplenishFor(r)}><ArrowDownToLine aria-hidden="true" className="h-3.5 w-3.5" />{t.consumables.supply}</Button>}
                          {expIssue && <Button size="sm" variant="outline" onClick={() => setIssueFor(r)}><ArrowUpFromLine aria-hidden="true" className="h-3.5 w-3.5" />{t.consumables.issue}</Button>}
                          {catalogWrite && expAddEdit && <Button size="sm" variant="ghost" onClick={() => setEditFor(r)}><Pencil aria-hidden="true" className="h-3.5 w-3.5" />{t.consumables.edit}</Button>}
                        </div>
                      ) : (
                        <Link href={`/consumables/${r.id}`} prefetch={false} className={buttonClass("ghost", "sm", "text-brand-ink")}><Eye aria-hidden="true" className="h-3.5 w-3.5" />{t.common.view}</Link>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
      {cursor && (
        <div className="mt-4 flex justify-center">
          <Button variant="outline" disabled={loading || loadingMore} onClick={() => void load(false)}>
            {loadingMore ? t.consumables.loading : t.reports.showMore}
          </Button>
        </div>
      )}

      <ReplenishDialog item={replenishFor} suppliers={opts?.suppliers ?? []} fin={fin} t={t} onClose={() => setReplenishFor(null)}
        onDone={(m) => { setToast(m); if (m.persisted) { setReplenishFor(null); load(); } }} />
      <IssueDialog item={issueFor} employees={opts?.employees ?? []} departments={opts?.departments ?? []} t={t} onClose={() => setIssueFor(null)}
        onDone={(m: ToastState) => { setToast(m); if (m?.type === "success") { setIssueFor(null); load(); } }} />
      <AddConsumableDialog open={addOpen} cats={cats} companies={companies} t={t} fin={fin} onClose={() => setAddOpen(false)}
        onDone={(m: ToastState) => { setToast(m); if (m?.type === "success") { setAddOpen(false); load(); } }} />
      <EditConsumableDialog item={editFor} cats={cats} companies={companies} suppliers={opts?.suppliers ?? []} locations={opts?.locations ?? []} t={t} onClose={() => setEditFor(null)}
        onDone={(m: ToastState) => { setToast(m); if (m?.type === "success") { setEditFor(null); load(); } }} />

      <Toast toast={toast} onDone={() => setToast(null)} />
    </div>
  );
}

// ملخّص النواقص أعلى اللوحة — «النواقص أولًا». أزرار عدّ قابلة للنقر تُفعّل الفلتر (toggle)،
// وعند غياب أي نقص تُعرض حالة إيجابية هادئة. العدّ يستند لشروط التنبيهات الموحّدة.
function AddConsumableDialog({ open, cats, companies, t, fin, onClose, onDone }: any) {
  const cf = (t as Dict).consumables.form;
  const [f, setF] = useState({ category_id: "", name: "", sku: "", rfid_tag: "", unit: "piece", quantity_on_hand: "", reorder_level: "", unit_cost: "", company_id: "" });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<Record<string,string>>({});
  const set = (k: string) => (v: string) => setF((s) => ({ ...s, [k]: v }));
  async function submit() {
    const e: Record<string,string> = {};
    const quantity = parseStrictInteger(f.quantity_on_hand, { emptyValue: 0 });
    const reorderLevel = parseStrictInteger(f.reorder_level, { emptyValue: 0 });
    const unitCost = parseStrictDecimal(f.unit_cost);
    if (!f.category_id) e.category_id = cf.errCategory;
    if (!f.name.trim()) e.name = cf.errName;
    if (!quantity.ok) e.quantity_on_hand = cf.errInvalidNumber;
    if (!reorderLevel.ok) e.reorder_level = cf.errInvalidNumber;
    if (!unitCost.ok) e.unit_cost = cf.errInvalidNumber;
    setErr(e); if (Object.keys(e).length) return;
    if (!quantity.ok || !reorderLevel.ok || !unitCost.ok) return;
    setBusy(true);
    const msg = await createConsumable({
      category_id: f.category_id, name: f.name.trim(), sku: f.sku.trim() || null, unit: f.unit,
      quantity_on_hand: quantity.value ?? 0, reorder_level: reorderLevel.value ?? 0,
      unit_cost: unitCost.value, company_id: f.company_id || null,
      rfid_tag: f.rfid_tag.trim() || null,
    } as any);
    setBusy(false);
    onDone(msg ? { type: "error", message: msg } : { type: "success", message: cf.added });
  }
  return (
    <Dialog open={open} onClose={onClose} title={cf.addTitle}
      footer={<><Button variant="outline" onClick={onClose}>{(t as Dict).common.cancel}</Button><Button onClick={submit} disabled={busy}>{busy ? (t as Dict).common.saving : (t as Dict).common.save}</Button></>}>
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={cf.category} required error={err.category_id}><Select value={f.category_id} onChange={set("category_id")} placeholder={cf.choose} options={(cats ?? []).map((c: any) => ({ value: c.id, label: c.name_ar ?? c.name }))} /></Field>
          <Field label={cf.unit}><Select value={f.unit} onChange={set("unit")} options={UNIT_KEYS.map((v)=>({value:v,label:cf.units[v]}))} /></Field>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={cf.name} required error={err.name}><input className={inputClass} value={f.name} onChange={(e) => set("name")(e.target.value)} /></Field>
          <Field label={cf.company}><Select value={f.company_id} onChange={set("company_id")} placeholder={cf.chooseCompany} options={(companies ?? []).map((c: any) => ({ value: c.id, label: c.name }))} /></Field>
        </div>
        <div className={`grid grid-cols-1 gap-3 ${fin ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}>
          <Field label={cf.quantity} error={err.quantity_on_hand}><input className={inputClass} value={f.quantity_on_hand} onChange={(e) => set("quantity_on_hand")(e.target.value)} dir="ltr" inputMode="numeric" /></Field>
          <Field label={cf.reorder} error={err.reorder_level}><input className={inputClass} value={f.reorder_level} onChange={(e) => set("reorder_level")(e.target.value)} dir="ltr" inputMode="numeric" /></Field>
          {fin && <Field label={cf.unitCost} error={err.unit_cost}><input className={inputClass} value={f.unit_cost} onChange={(e) => set("unit_cost")(e.target.value)} dir="ltr" inputMode="decimal" /></Field>}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={cf.sku}><input className={inputClass} value={f.sku} onChange={(e) => set("sku")(e.target.value)} dir="ltr" /></Field>
          <Field label={cf.rfid}><input className={inputClass} value={f.rfid_tag} onChange={(e) => set("rfid_tag")(e.target.value)} dir="ltr" /></Field>
        </div>
      </div>
    </Dialog>
  );
}
