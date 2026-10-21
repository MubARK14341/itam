"use client";

// ============================================================================
//  إعدادات بوابة العميل (Phase 5) — admin/it_manager فقط (مفروض في القاعدة عبر RPCs).
//  المفاتيح، قائمة الشركات المسموحة، وقائمة التصنيفات المسموحة — حفظ موحّد.
//  الأمان في القاعدة؛ هذه الواجهة لا تفرض شيئًا (تُخفي/تُظهر فقط).
// ============================================================================

import { useEffect, useState } from "react";
import { Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { ToastState } from "@/components/ui/toast";
import {
  getCustomerPortalSettings, updateCustomerPortalSettings,
  setCustomerAllowedCompanies, setCustomerAllowedCategories, listCompanies,
  type CustomerPortalSettings, type CompanyRow,
} from "@/lib/requests";
import { PORTAL_CATEGORY_CATALOG } from "@/lib/portal-catalog";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";

const DEFAULT_SETTINGS: CustomerPortalSettings = {
  portal_enabled: true, allow_rental_requests: true, allow_purchase_requests: true,
  allow_maintenance_requests: true, allow_custom_requests: true, allow_custom_item_requests: true,
  allow_attachments: true, require_project_manager_approval: false,
};

const FLAG_KEYS: (keyof CustomerPortalSettings)[] = [
  "portal_enabled", "allow_rental_requests", "allow_purchase_requests", "allow_maintenance_requests",
  "allow_custom_requests", "allow_custom_item_requests", "allow_attachments", "require_project_manager_approval",
];

export function PortalSettingsSection({ customerId, onToast }: { customerId: string; onToast: (m: ToastState) => void }) {
  const { t, lang } = useAppPreferences();
  const ts = t.portalSettings;
  const [settings, setSettings] = useState<CustomerPortalSettings>(DEFAULT_SETTINGS);
  const [companies, setCompanies] = useState<CompanyRow[]>([]);
  const [companyIds, setCompanyIds] = useState<Set<string>>(new Set());
  const [catKeys, setCatKeys] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      const [cfg, comps] = await Promise.all([getCustomerPortalSettings(customerId), listCompanies()]);
      if (!active) return;
      setCompanies(comps);
      if (cfg.data) {
        setSettings(cfg.data.settings);
        setCompanyIds(new Set(cfg.data.allowed_companies.map((c) => c.company_id)));
        setCatKeys(new Set(cfg.data.allowed_categories.map((c) => c.category_key)));
      } else {
        setSettings(DEFAULT_SETTINGS);
      }
      setLoading(false);
    })();
    return () => { active = false; };
  }, [customerId]);

  const toggleFlag = (k: keyof CustomerPortalSettings) => setSettings((s) => ({ ...s, [k]: !s[k] }));
  const toggleCompany = (id: string) => setCompanyIds((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleCat = (key: string) => setCatKeys((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });

  async function saveAll() {
    setBusy(true);
    const e1 = await updateCustomerPortalSettings(customerId, settings);
    const e2 = await setCustomerAllowedCompanies(customerId, Array.from(companyIds));
    const cats = PORTAL_CATEGORY_CATALOG.filter((c) => catKeys.has(c.key))
      .map((c) => ({ key: c.key, label_ar: c.label_ar, label_en: c.label_en }));
    const e3 = await setCustomerAllowedCategories(customerId, cats);
    setBusy(false);
    const err = e1 || e2 || e3;
    onToast(err
      ? { type: "error", message: ts.saveError + ((t.requests.err as Record<string, string>)[err] ?? err) }
      : { type: "success", message: ts.saved });
  }

  if (loading) {
    return (
      <div className="rounded-xl border border-line p-4">
        <Spinner label={ts.loading} />
      </div>
    );
  }

  return (
    <section aria-labelledby={`portal-settings-${customerId}`} className="rounded-xl border border-line p-4">
      <h3 id={`portal-settings-${customerId}`} className="mb-3 text-sm font-semibold text-fg">{ts.title}</h3>

      {/* المفاتيح */}
      <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
        {FLAG_KEYS.map((k) => (
          <label key={k} className="flex min-h-9 cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1 text-[13px] text-fg-2 hover:bg-surface-2 max-md:min-h-11">
            <input type="checkbox" checked={settings[k]} onChange={() => toggleFlag(k)} className="h-4 w-4 shrink-0 rounded accent-brand" />
            {(ts.flags as Record<string, string>)[k]}
          </label>
        ))}
      </div>

      {/* الشركات المسموحة */}
      <div className="mt-4 border-t border-line pt-4">
        <p className="text-[13px] font-semibold text-fg">{ts.companies}</p>
        <p className="mb-2 text-xs text-muted">{ts.companiesHint}</p>
        {companies.length === 0 ? (
          <p className="text-xs text-muted">{ts.noCompanies}</p>
        ) : (
          <div className="grid max-h-40 grid-cols-2 gap-1.5 overflow-y-auto rounded-xl border border-line p-2.5 sm:grid-cols-3">
            {companies.map((c) => (
              <label key={c.id} className="flex cursor-pointer items-center gap-1.5 text-xs text-fg-2">
                <input type="checkbox" checked={companyIds.has(c.id)} onChange={() => toggleCompany(c.id)} className="h-3.5 w-3.5 shrink-0 rounded accent-brand" />
                <span className="truncate">{c.name}</span>
              </label>
            ))}
          </div>
        )}
      </div>

      {/* التصنيفات المسموحة */}
      <div className="mt-4 border-t border-line pt-4">
        <p className="text-[13px] font-semibold text-fg">{ts.categories}</p>
        <p className="mb-2 text-xs text-muted">{ts.categoriesHint}</p>
        <div className="flex flex-wrap gap-2">
          {PORTAL_CATEGORY_CATALOG.map((c) => (
            <label key={c.key} className={`flex min-h-8 cursor-pointer items-center gap-1.5 rounded-full border px-3 text-xs font-medium ${catKeys.has(c.key) ? "border-brand bg-brand-soft text-brand-ink" : "border-line-strong text-fg-2 hover:border-muted"}`}>
              <input type="checkbox" checked={catKeys.has(c.key)} onChange={() => toggleCat(c.key)} className="h-3.5 w-3.5 rounded accent-brand" />
              {lang === "ar" ? c.label_ar : c.label_en}
            </label>
          ))}
        </div>
      </div>

      <div className="mt-4 flex justify-end">
        <Button size="sm" disabled={busy} onClick={saveAll}><Save aria-hidden="true" />{busy ? ts.saving : ts.save}</Button>
      </div>
    </section>
  );
}
