"use client";

// ============================================================================
//  إدارة الكتالوج (Batch E) — تصنيفات · ماركات (شركات) · موديلات.
//  admin/it_manager فقط (مفروض في القاعدة عبر RLS + بوابة الإعدادات canManageSettings).
//  RLS الفعلي: التصنيفات كتابة admin فقط؛ الموديلات إدراج admin/it_manager وتحديث admin.
//  ⇒ إخفاء أزرار الكتابة الخاصة بـadmin تجميليًا فقط (لا يغيّر أي دور/سياسة). لا حذف — is_active.
//  الماركات: تُعاد شاشة الشركات القائمة كما هي (إعادة استخدام، لا تكرار).
//  صفر: أسعار · تكاليف · مخزون · موردون · معرّفات أصول · pool_id.
// ============================================================================

import { useEffect, useMemo, useState } from "react";
import { Plus, Pencil, Power, Boxes, Tag, Factory, Lock } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusChip } from "@/components/ui/status-chip";
import { Tabs, panelId, tabId, type TabItem } from "@/components/ui/tabs";
import { Field, SearchInput, Select, inputClass } from "@/components/ui/form";
import { Toast, type ToastState } from "@/components/ui/toast";
import {
  listCategoriesAdmin, createCategory, updateCategory, setCategoryActive, type CategoryAdminRow,
  listModelsAdmin, createCatalogModel, updateCatalogModel, setCatalogModelActive, type ModelAdminRow,
  listCompaniesAdmin, type CompanyAdminRow,
} from "@/lib/queries";
import { CompaniesSettings } from "@/components/settings/companies-settings";
import { useSession, isAdmin } from "@/lib/session";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { ActiveChip, Callout, CheckboxFilter, TableMessage, Toolbar, checkboxClass } from "@/components/settings/settings-ui";
import { friendlyErrorStrict } from "@/lib/user-facing-errors";

type SubTab = "models" | "categories" | "brands";
const KINDS = ["asset", "accessory", "consumable", "special"] as const;

export function CatalogSettings() {
  const { t } = useAppPreferences();
  const [sub, setSub] = useState<SubTab>("models");
  const tabs: TabItem<SubTab>[] = [
    { key: "models", label: t.catalog.tabModels, icon: <Boxes aria-hidden="true" className="h-4 w-4" /> },
    { key: "categories", label: t.catalog.tabCategories, icon: <Tag aria-hidden="true" className="h-4 w-4" /> },
    { key: "brands", label: t.catalog.tabBrands, icon: <Factory aria-hidden="true" className="h-4 w-4" /> },
  ];
  return (
    <div className="space-y-4">
      <Tabs items={tabs} value={sub} onChange={setSub} label={t.settings.tabs.catalog} idBase="catalog" variant="segmented" />
      <div role="tabpanel" id={panelId("catalog", sub)} aria-labelledby={tabId("catalog", sub)}>
        {sub === "models" && <ModelsPanel />}
        {sub === "categories" && <CategoriesPanel />}
        {sub === "brands" && <CompaniesSettings />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// التصنيفات — كتابة admin فقط (RLS). تُعرض للمدير للقراءة، وأزرار الكتابة لـadmin.
// ---------------------------------------------------------------------------
function CategoriesPanel() {
  const { t, lang } = useAppPreferences();
  const { role } = useSession();
  const admin = isAdmin(role);
  const tc = t.catalog;
  const [rows, setRows] = useState<CategoryAdminRow[]>([]);
  const [counts, setCounts] = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [activeOnly, setActiveOnly] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);
  const [editing, setEditing] = useState<CategoryAdminRow | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  async function load() {
    const [cats, models] = await Promise.all([listCategoriesAdmin(), listModelsAdmin()]);
    if (cats.error) setToast({ type: "error", message: tc.error + cats.error });
    const m = new Map<string, number>();
    models.rows.forEach((r) => m.set(r.category_id, (m.get(r.category_id) ?? 0) + 1));
    setCounts(m);
    setRows(cats.rows);
    setLoading(false);
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => rows.filter((r) => {
    if (activeOnly && !r.is_active) return false;
    if (q && !`${r.name} ${r.name_ar ?? ""} ${r.prefix}`.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  }), [rows, q, activeOnly]);

  async function toggleActive(r: CategoryAdminRow) {
    const e = await setCategoryActive(r.id, !r.is_active);
    if (e) { setToast({ type: "error", message: tc.error + e }); return; }
    setToast({ type: "success", message: tc.catUpdated });
    load();
  }
  const kindLabel = (k: string) => (tc.kinds as Record<string, string>)[k] ?? k;
  const nameOf = (r: CategoryAdminRow) => (lang === "ar" ? r.name_ar || r.name : r.name);

  return (
    <div>
      <Card>
        <CardHeader
          title={tc.tabCategories}
          description={tc.catSubtitle}
          actions={admin ? <Button onClick={() => setAddOpen(true)}><Plus aria-hidden="true" />{tc.catAdd}</Button> : undefined}
        />
        {!admin && (
          <div className="border-b border-line px-5 py-3">
            <Callout tone="warn" icon={Lock}>{tc.catAdminOnly}</Callout>
          </div>
        )}
        <Toolbar>
          <SearchInput label={tc.catSearch} value={q} onChange={(e) => setQ(e.target.value)} placeholder={tc.catSearch}
            onClear={() => setQ("")} clearLabel={t.common.clearSearch} containerClassName="min-w-[220px] flex-1" />
          <CheckboxFilter label={tc.activeOnly} checked={activeOnly} onChange={setActiveOnly} />
          {!loading && <span className="ms-auto text-[13px] tabular-nums text-muted">{filtered.length} / {rows.length}</span>}
        </Toolbar>
        <div tabIndex={0} className="overflow-x-auto">
          <table className="ui-table">
            <thead>
              <tr>
                <th>{tc.catName}</th>
                <th>{tc.catPrefix}</th>
                <th>{tc.catKind}</th>
                <th>{tc.mdlCountByCategory}</th>
                <th>{tc.status}</th>
                {admin && <th>{tc.actions}</th>}
              </tr>
            </thead>
            <tbody>
              {loading ? <TableMessage colSpan={admin ? 6 : 5} loading />
              : filtered.length === 0 ? <TableMessage colSpan={admin ? 6 : 5}><EmptyState compact icon={Tag} title={tc.catEmpty} /></TableMessage>
              : filtered.map((r) => (
                <tr key={r.id}>
                  <td className={`font-medium ${r.is_active ? "text-fg" : "text-muted"}`}>{nameOf(r)}</td>
                  <td><span className="font-mono text-[13px] font-medium text-brand-ink [unicode-bidi:isolate]" dir="ltr">{r.prefix}</span></td>
                  <td><StatusChip tone="neu" dot={false} size="sm">{kindLabel(r.kind)}</StatusChip></td>
                  <td className="tabular-nums text-fg-2">{counts.get(r.id) ?? 0}</td>
                  <td><ActiveChip active={r.is_active} activeLabel={tc.active} inactiveLabel={tc.inactive} /></td>
                  {admin && (
                    <td>
                      <div className="flex gap-1">
                        <Button size="sm" variant="ghost" onClick={() => setEditing(r)}><Pencil aria-hidden="true" />{t.common.edit}</Button>
                        <Button size="sm" variant="outline" onClick={() => toggleActive(r)}><Power aria-hidden="true" />{r.is_active ? tc.disable : tc.enable}</Button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {admin && <CategoryDialog open={addOpen} onClose={() => setAddOpen(false)} onDone={(m) => { setAddOpen(false); setToast(m); load(); }} />}
      {admin && <CategoryDialog open={!!editing} row={editing} onClose={() => setEditing(null)} onDone={(m) => { setEditing(null); setToast(m); load(); }} />}
      <Toast toast={toast} onDone={() => setToast(null)} />
    </div>
  );
}

function CategoryDialog({ open, row, onClose, onDone }: {
  open: boolean; row?: CategoryAdminRow | null; onClose: () => void; onDone: (m: ToastState) => void;
}) {
  const { t, lang } = useAppPreferences();
  const tc = t.catalog;
  const [f, setF] = useState({ name: "", name_ar: "", prefix: "", kind: "asset", is_active: true });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (!open) return;
    setF(row
      ? { name: row.name ?? "", name_ar: row.name_ar ?? "", prefix: row.prefix ?? "", kind: row.kind ?? "asset", is_active: row.is_active }
      : { name: "", name_ar: "", prefix: "", kind: "asset", is_active: true });
    setErr("");
  }, [open, row]);

  async function submit() {
    if (!f.name.trim()) { setErr(tc.catNameRequired); return; }
    if (!f.prefix.trim()) { setErr(tc.catPrefixRequired); return; }
    // نفس قيد القاعدة prefix_format (^[A-Z]{2,5}$) — رسالة واضحة بدل نص الخطأ الخام.
    if (!/^[A-Z]{2,5}$/.test(f.prefix.trim())) { setErr(tc.catPrefixFormat); return; }
    setBusy(true);
    const payload = { name: f.name, name_ar: f.name_ar.trim() || null, prefix: f.prefix.trim(), kind: f.kind, is_active: f.is_active };
    const e = row ? await updateCategory(row.id, payload) : await createCategory(payload);
    setBusy(false);
    if (e) { setErr(e === "duplicate" ? tc.duplicate : friendlyErrorStrict(e, lang)); return; }
    onDone({ type: "success", message: row ? tc.catUpdated : tc.catSaved });
  }

  return (
    <Dialog open={open} onClose={onClose} title={row ? tc.catEdit : tc.catAdd}
      footer={<><Button variant="outline" onClick={onClose}>{tc.cancel}</Button><Button onClick={submit} disabled={busy}>{busy ? tc.saving : tc.save}</Button></>}>
      <div className="space-y-4">
        <Field label={tc.catName} required error={err}>
          <input className={inputClass} value={f.name} onChange={(e) => setF((s) => ({ ...s, name: e.target.value }))} dir="ltr" />
        </Field>
        <Field label={tc.catNameAr}>
          <input className={inputClass} value={f.name_ar} onChange={(e) => setF((s) => ({ ...s, name_ar: e.target.value }))} />
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={tc.catPrefix}>
            <input className={inputClass} value={f.prefix} onChange={(e) => setF((s) => ({ ...s, prefix: e.target.value.toUpperCase() }))} dir="ltr" />
          </Field>
          <Field label={tc.catKind}>
            <Select value={f.kind} onChange={(v) => setF((s) => ({ ...s, kind: v }))}
              options={KINDS.map((k) => ({ value: k, label: (tc.kinds as Record<string, string>)[k] }))} />
          </Field>
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-fg-2">
          <input type="checkbox" checked={f.is_active} onChange={(e) => setF((s) => ({ ...s, is_active: e.target.checked }))} className={checkboxClass} />
          {tc.active}
        </label>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// الموديلات — إدراج admin/it_manager (كل من يرى الشاشة)؛ تحديث/تعطيل admin فقط (RLS).
// ---------------------------------------------------------------------------
function ModelsPanel() {
  const { t, lang } = useAppPreferences();
  const { role } = useSession();
  const admin = isAdmin(role);
  const tc = t.catalog;
  const [rows, setRows] = useState<ModelAdminRow[]>([]);
  const [cats, setCats] = useState<CategoryAdminRow[]>([]);
  const [companies, setCompanies] = useState<CompanyAdminRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [catFilter, setCatFilter] = useState("");
  const [activeOnly, setActiveOnly] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);
  const [editing, setEditing] = useState<ModelAdminRow | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  async function load() {
    const [m, c, co] = await Promise.all([listModelsAdmin(), listCategoriesAdmin(), listCompaniesAdmin()]);
    if (m.error) setToast({ type: "error", message: tc.error + m.error });
    setRows(m.rows); setCats(c.rows); setCompanies(co.rows);
    setLoading(false);
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => rows.filter((r) => {
    if (activeOnly && !r.is_active) return false;
    if (catFilter && r.category_id !== catFilter) return false;
    if (q && !`${r.model_name} ${r.company_name ?? ""} ${r.category_name ?? ""}`.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  }), [rows, q, catFilter, activeOnly]);

  const catName = (r: ModelAdminRow) => {
    const c = cats.find((x) => x.id === r.category_id);
    return c ? (lang === "ar" ? c.name_ar || c.name : c.name) : (r.category_name ?? "—");
  };
  const catOptions = useMemo(() =>
    [{ value: "", label: tc.mdlAllCategories }].concat(
      cats.map((c) => ({ value: c.id, label: lang === "ar" ? c.name_ar || c.name : c.name })),
    ), [cats, lang, tc.mdlAllCategories]);

  async function toggleActive(r: ModelAdminRow) {
    const e = await setCatalogModelActive(r.id, !r.is_active);
    if (e) { setToast({ type: "error", message: tc.error + e }); return; }
    setToast({ type: "success", message: tc.mdlUpdated });
    load();
  }

  return (
    <div>
      <Card>
        <CardHeader
          title={tc.tabModels}
          description={tc.mdlSubtitle}
          actions={<Button onClick={() => setAddOpen(true)}><Plus aria-hidden="true" />{tc.mdlAdd}</Button>}
        />
        {!admin && (
          <div className="border-b border-line px-5 py-3">
            <Callout tone="warn" icon={Lock}>{tc.mdlAdminEditOnly}</Callout>
          </div>
        )}
        <Toolbar>
          <SearchInput label={tc.mdlSearch} value={q} onChange={(e) => setQ(e.target.value)} placeholder={tc.mdlSearch}
            onClear={() => setQ("")} clearLabel={t.common.clearSearch} containerClassName="min-w-[200px] flex-1" />
          <div className="min-w-[180px]">
            <Select value={catFilter} onChange={setCatFilter} options={catOptions} label={tc.mdlAllCategories} />
          </div>
          <CheckboxFilter label={tc.activeOnly} checked={activeOnly} onChange={setActiveOnly} />
          {!loading && <span className="ms-auto text-[13px] tabular-nums text-muted">{filtered.length} / {rows.length}</span>}
        </Toolbar>
        <div tabIndex={0} className="overflow-x-auto">
          <table className="ui-table">
            <thead>
              <tr>
                <th>{tc.mdlName}</th>
                <th>{tc.mdlCategory}</th>
                <th>{tc.mdlCompany}</th>
                <th>{tc.status}</th>
                {admin && <th>{tc.actions}</th>}
              </tr>
            </thead>
            <tbody>
              {loading ? <TableMessage colSpan={admin ? 5 : 4} loading />
              : filtered.length === 0 ? <TableMessage colSpan={admin ? 5 : 4}><EmptyState compact icon={Boxes} title={tc.mdlEmpty} /></TableMessage>
              : filtered.map((r) => (
                <tr key={r.id}>
                  <td className={`font-medium ${r.is_active ? "text-fg" : "text-muted"}`}>{r.model_name}</td>
                  <td className="text-fg-2">{catName(r)}</td>
                  <td className="text-fg-2">{r.company_name ?? "—"}</td>
                  <td><ActiveChip active={r.is_active} activeLabel={tc.active} inactiveLabel={tc.inactive} /></td>
                  {admin && (
                    <td>
                      <div className="flex gap-1">
                        <Button size="sm" variant="ghost" onClick={() => setEditing(r)}><Pencil aria-hidden="true" />{t.common.edit}</Button>
                        <Button size="sm" variant="outline" onClick={() => toggleActive(r)}><Power aria-hidden="true" />{r.is_active ? tc.disable : tc.enable}</Button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <ModelDialog open={addOpen} cats={cats} companies={companies} onClose={() => setAddOpen(false)} onDone={(m) => { setAddOpen(false); setToast(m); load(); }} />
      {admin && <ModelDialog open={!!editing} row={editing} cats={cats} companies={companies} onClose={() => setEditing(null)} onDone={(m) => { setEditing(null); setToast(m); load(); }} />}
      <Toast toast={toast} onDone={() => setToast(null)} />
    </div>
  );
}

function ModelDialog({ open, row, cats, companies, onClose, onDone }: {
  open: boolean; row?: ModelAdminRow | null; cats: CategoryAdminRow[]; companies: CompanyAdminRow[];
  onClose: () => void; onDone: (m: ToastState) => void;
}) {
  const { t, lang } = useAppPreferences();
  const tc = t.catalog;
  const [f, setF] = useState({ category_id: "", company_id: "", model_name: "", is_active: true });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (!open) return;
    setF(row
      ? { category_id: row.category_id, company_id: row.company_id ?? "", model_name: row.model_name, is_active: row.is_active }
      : { category_id: "", company_id: "", model_name: "", is_active: true });
    setErr("");
  }, [open, row]);

  // خيارات مفعّلة فقط (زائدًا القيمة الحالية للحفاظ عليها عند التحرير).
  const catOptions = cats.filter((c) => c.is_active || c.id === f.category_id)
    .map((c) => ({ value: c.id, label: lang === "ar" ? c.name_ar || c.name : c.name }));
  const companyOptions = companies.filter((c) => c.is_active || c.id === f.company_id)
    .map((c) => ({ value: c.id, label: c.name }));

  async function submit() {
    if (!f.category_id) { setErr(tc.mdlCategoryRequired); return; }
    if (!f.company_id) { setErr(tc.mdlCompanyRequired); return; }
    if (!f.model_name.trim()) { setErr(tc.mdlNameRequired); return; }
    setBusy(true);
    const payload = { category_id: f.category_id, company_id: f.company_id, model_name: f.model_name, is_active: f.is_active };
    const e = row ? await updateCatalogModel(row.id, payload) : await createCatalogModel(payload);
    setBusy(false);
    if (e) { setErr(e === "duplicate" ? tc.duplicate : tc.error + e); return; }
    onDone({ type: "success", message: row ? tc.mdlUpdated : tc.mdlSaved });
  }

  return (
    <Dialog open={open} onClose={onClose} title={row ? tc.mdlEdit : tc.mdlAdd}
      footer={<><Button variant="outline" onClick={onClose}>{tc.cancel}</Button><Button onClick={submit} disabled={busy}>{busy ? tc.saving : tc.save}</Button></>}>
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={tc.mdlCategory} required>
            <Select value={f.category_id} onChange={(v) => setF((s) => ({ ...s, category_id: v }))} options={catOptions} placeholder="—" />
          </Field>
          <Field label={tc.mdlCompany} required>
            <Select value={f.company_id} onChange={(v) => setF((s) => ({ ...s, company_id: v }))} options={companyOptions} placeholder="—" />
          </Field>
        </div>
        <Field label={tc.mdlName} required error={err}>
          <input className={inputClass} value={f.model_name} onChange={(e) => setF((s) => ({ ...s, model_name: e.target.value }))} />
        </Field>
        <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-fg-2">
          <input type="checkbox" checked={f.is_active} onChange={(e) => setF((s) => ({ ...s, is_active: e.target.checked }))} className={checkboxClass} />
          {tc.active}
        </label>
      </div>
    </Dialog>
  );
}
