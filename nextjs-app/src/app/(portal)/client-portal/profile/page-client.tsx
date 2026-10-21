"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, Building2, MapPin } from "lucide-react";
import { Field, inputClass } from "@/components/ui/form";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Spinner } from "@/components/ui/spinner";
import { StatusChip } from "@/components/ui/status-chip";
import { Toast, type ToastState } from "@/components/ui/toast";
import { createClient } from "@/lib/supabase/client";
import { portalGetProfile, portalUpdateProfile, type PortalProfile } from "@/lib/portal";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { usePortalSession } from "@/components/providers/portal-session";

// ملفي الشخصي (بوابة العميل) — عرض + تحرير حقيقي عبر portal_update_profile.
// الهوية تُشتق في القاعدة من auth.uid() (لا معرّف من الواجهة). البريد = هوية الجلسة (عرض فقط).
// الاسم والجوال قابلان للتحرير لكل الأدوار؛ المدينة لمدير المشروع فقط (غيره: عرض فقط بملاحظة صريحة).
// عزل: لا ملاحظات إدارية، لا حالة مالية/ائتمانية، لا معرّفات داخلية، لا مسارات تخزين.
export default function PortalProfilePage() {
  const { t } = useAppPreferences();
  const tp = t.portal;
  const tpr = tp.profile;
  const ctx = usePortalSession();
  const isPM = ctx?.portal_role === "project_manager";

  const [email, setEmail] = useState("");
  const [profile, setProfile] = useState<PortalProfile | null>(null);
  const [f, setF] = useState({ contact_name: "", phone: "", city: "" });
  const [errors, setErrors] = useState<{ contact_name?: string; phone?: string }>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);

  useEffect(() => {
    createClient().auth.getUser().then(({ data }) => setEmail(data.user?.email ?? ""));
    portalGetProfile().then(({ data }) => {
      if (data) {
        setProfile(data);
        setF({ contact_name: data.contact_name ?? "", phone: data.phone ?? "", city: data.city ?? "" });
      }
      setLoading(false);
    });
  }, []);

  const set = (k: "contact_name" | "phone" | "city") => (v: string) => {
    setF((s) => ({ ...s, [k]: v }));
    if (k === "contact_name" || k === "phone") setErrors((e) => ({ ...e, [k]: undefined }));
  };

  const roleLabel = profile
    ? (tp.invite.roles as Record<string, string>)[profile.portal_role] ?? profile.portal_role
    : "";

  // تحقق واجهة (القاعدة تفرض الجوال والاسم أيضًا). جوال دولي متساهل.
  function validate() {
    const e: { contact_name?: string; phone?: string } = {};
    if (!f.contact_name.trim()) e.contact_name = tpr.errName;
    const digits = f.phone.trim().replace(/[\s().\-]/g, "");
    if (!/^\+?\d{7,15}$/.test(digits)) e.phone = tpr.errPhone;
    return e;
  }

  async function save() {
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    // المدينة تُرسَل لمدير المشروع فقط (القاعدة تتجاهلها لغيره على أي حال).
    const err = await portalUpdateProfile({
      contact_name: f.contact_name.trim(),
      phone: f.phone.trim(),
      city: isPM ? (f.city.trim() || null) : null,
    });
    setBusy(false);
    if (err) {
      const msg = /phone_required/.test(err) ? tpr.errPhone
        : /contact_name_required/.test(err) ? tpr.errName
        : tpr.saveError;
      setToast({ type: "error", message: msg });
      return;
    }
    setProfile((p) => (p ? { ...p, contact_name: f.contact_name.trim(), phone: f.phone.trim(), city: isPM ? f.city.trim() : p.city } : p));
    setToast({ type: "success", message: tpr.saved });
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5">
      <div>
        <Link href="/client-portal/requests" className="mb-1 inline-flex min-h-11 items-center gap-1 text-[13px] font-medium text-muted hover:text-fg">
          <ArrowRight aria-hidden="true" className="h-4 w-4 ltr:rotate-180" />{tp.back}
        </Link>
        <PageHeader className="!mb-0" title={tpr.title} />
      </div>

      {loading ? (
        <div className="ui-surface flex justify-center p-10"><Spinner label={tp.loading} /></div>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,.9fr)_minmax(0,1.3fr)] lg:items-start">
          {/* عرض فقط: الشركة + الدور + حالة البوابة */}
          <section aria-labelledby="portal-profile-company" className="ui-surface p-5 sm:p-6">
            <div className="flex items-center gap-3.5">
              <span className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-[14px] bg-fg text-canvas">
                <Building2 aria-hidden="true" className="h-6 w-6" />
              </span>
              <div className="min-w-0">
                <h2 id="portal-profile-company" className="font-display text-[18px] font-semibold leading-snug text-fg">{profile?.company_name || "—"}</h2>
                {profile?.city && <p className="mt-0.5 flex items-center gap-1 text-[13px] text-muted"><MapPin aria-hidden="true" className="h-3.5 w-3.5" />{profile.city}</p>}
              </div>
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-line pt-3.5">
              <ReadonlyRow label={tpr.companyName} value={profile?.company_name || "—"} />
              <ReadonlyRow label={tpr.role} value={roleLabel || "—"} />
              <div className="col-span-2">
                <dt className="text-xs text-muted">{tp.ledger.portalStatus}</dt>
                <dd className="mt-1"><StatusChip tone="ok">{tp.ledger.portalEnabled}</StatusChip></dd>
              </div>
            </dl>
          </section>

          <section aria-labelledby="portal-profile-contact" className="ui-surface overflow-hidden">
            <div className="flex items-center gap-3 px-4 py-3.5 sm:px-5">
              <span aria-hidden="true" className="ui-avatar h-10 w-10 bg-brand-soft text-[13px] text-brand-ink">{initials(f.contact_name || profile?.contact_name || "")}</span>
              <h2 id="portal-profile-contact" className="font-display text-[17px] font-semibold text-fg">{tp.ledger.contactCard}</h2>
            </div>
            <div className="space-y-4 border-t border-line px-4 py-4 sm:px-5">
              <Field label={tpr.email} hint={tpr.emailNote}>
                <input className={`${inputClass} bg-sunk`} value={email} dir="ltr" readOnly />
              </Field>

              {/* تحرير: الاسم + الجوال (كل الأدوار) */}
              <Field label={tpr.contactName} required error={errors.contact_name}>
                <input className={inputClass} value={f.contact_name} onChange={(e) => set("contact_name")(e.target.value)} />
              </Field>
              <Field label={tpr.phone} required error={errors.phone}>
                <input className={`${inputClass} tabular-nums`} value={f.phone} onChange={(e) => set("phone")(e.target.value)} dir="ltr" inputMode="tel" />
              </Field>

              {/* المدينة: تحرير لمدير المشروع فقط؛ غيره عرض فقط بملاحظة */}
              {isPM ? (
                <Field label={tpr.city}>
                  <input className={inputClass} value={f.city} onChange={(e) => set("city")(e.target.value)} />
                </Field>
              ) : (
                <Field label={tpr.city} hint={tpr.cityReadonlyNote}>
                  <input className={`${inputClass} bg-sunk`} value={f.city} readOnly />
                </Field>
              )}
            </div>
            <div className="flex justify-end border-t border-line bg-surface-2 px-4 py-3 sm:px-5">
              <Button onClick={save} disabled={busy} className="max-sm:w-full">{busy ? tpr.saving : tpr.save}</Button>
            </div>
          </section>
        </div>
      )}

      <Toast toast={toast} onDone={() => setToast(null)} />
    </div>
  );
}

// أحرف أولى لصورة جهة الاتصال (عرض فقط).
function initials(name: string): string {
  return name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("") || "—";
}

function ReadonlyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5 font-semibold text-fg">{value}</dd>
    </div>
  );
}
