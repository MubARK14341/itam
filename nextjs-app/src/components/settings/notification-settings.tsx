"use client";

import { useEffect, useState } from "react";
import { Bell, Mail, Clock, ClipboardCheck, Wrench, Info, Save } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusChip } from "@/components/ui/status-chip";
import { Field, inputClass } from "@/components/ui/form";
import { Toast, type ToastState } from "@/components/ui/toast";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import {
  getNotificationSettings, updateNotificationSettings,
  DEFAULT_NOTIFICATION_SETTINGS, type NotificationSettings,
} from "@/lib/notifications";
import { EmailAutomationSettingsPanel } from "@/components/settings/email-automation-settings";
import {
  Callout, SectionLoading, SubHeading, SwitchRow, UnsavedChangesBar, differs,
} from "@/components/settings/settings-ui";

// تبويب «التنبيهات» في الإعدادات — admin/it_manager فقط (الوصول لـ Settings محكوم بالفعل + RLS).
// يتحكّم في التنبيهات الداخلية (In-App). البريد الإلكتروني معروض كـ «قريبًا» بلا أي إرسال فعلي.
export function NotificationSettingsPanel() {
  const { t } = useAppPreferences();
  const tn = t.notifications.settings;
  const [s, setS] = useState<NotificationSettings>(DEFAULT_NOTIFICATION_SETTINGS);
  // لقطة القيم المحمّلة/المحفوظة — لشريط «تغييرات غير محفوظة» فقط (واجهة).
  const [loaded, setLoaded] = useState<NotificationSettings>(DEFAULT_NOTIFICATION_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);

  useEffect(() => {
    getNotificationSettings().then((v) => { setS(v); setLoaded(v); setLoading(false); });
  }, []);

  const setBool = (k: keyof NotificationSettings) => (v: boolean) => setS((p) => ({ ...p, [k]: v }));
  const setNum = (k: keyof NotificationSettings) => (v: string) => {
    const n = Math.max(0, Math.trunc(Number(v)));
    setS((p) => ({ ...p, [k]: Number.isFinite(n) ? n : 0 }));
  };

  async function save() {
    setBusy(true);
    const err = await updateNotificationSettings(s);
    setBusy(false);
    if (!err) setLoaded(s);
    setToast(err ? { type: "error", message: tn.error + err } : { type: "success", message: tn.saved });
  }

  if (loading) return <SectionLoading />;

  return (
    <div className="space-y-4">
      <div>
        <Card>
          <CardHeader
            title={tn.section}
            description={tn.subtitle}
            actions={<Button onClick={save} disabled={busy}><Save aria-hidden="true" />{busy ? tn.saving : tn.save}</Button>}
          />
          <div className="space-y-6 px-5 py-5">
            {/* القنوات */}
            <div>
              <SubHeading>{tn.channels}</SubHeading>
              <div className="mt-1">
                <SwitchRow icon={Bell} label={tn.inApp} hint={tn.inAppHint} checked={s.in_app_enabled} onChange={setBool("in_app_enabled")} />
                {/* EDIT 5 uses a server-only Resend integration.  Settings and logs
                    below are manager-gated by database RPCs; this panel never sees
                    provider secrets. */}
                <div className="flex items-center gap-3 py-3.5">
                  <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-sunk text-fg-2">
                    <Mail aria-hidden="true" className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-fg">{tn.email}</p>
                    <p className="mt-0.5 text-[12.5px] text-muted">{t.notifications.emailAutomation.subtitle}</p>
                  </div>
                  <StatusChip tone="warn" size="sm">{t.notifications.emailAutomation.testMode}</StatusChip>
                </div>
              </div>
            </div>

            {/* أنواع التنبيهات */}
            <div className="border-t border-line pt-5">
              <SubHeading>{tn.alertTypes}</SubHeading>
              <div className="mt-1">
                <SwitchRow icon={Clock} label={tn.overdueRequests} checked={s.overdue_requests_enabled} onChange={setBool("overdue_requests_enabled")} />
                <SwitchRow icon={ClipboardCheck} label={tn.pendingApproval} checked={s.pending_approval_enabled} onChange={setBool("pending_approval_enabled")} />
                <SwitchRow icon={Wrench} label={tn.maintenanceDue} checked={s.maintenance_due_enabled} onChange={setBool("maintenance_due_enabled")} />
              </div>
            </div>

            {/* العتبات */}
            <div className="border-t border-line pt-5">
              <SubHeading>{tn.thresholds}</SubHeading>
              <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label={tn.overdueGraceDays} hint={tn.overdueGraceHint}>
                  <input className={`${inputClass} tabular-nums`} value={String(s.overdue_grace_days)} onChange={(e) => setNum("overdue_grace_days")(e.target.value)} dir="ltr" inputMode="numeric" min={0} />
                </Field>
                <Field label={tn.maintenanceWindow} hint={tn.maintenanceWindowHint}>
                  <input className={`${inputClass} tabular-nums`} value={String(s.maintenance_due_window_days)} onChange={(e) => setNum("maintenance_due_window_days")(e.target.value)} dir="ltr" inputMode="numeric" min={0} />
                </Field>
              </div>
            </div>

            <Callout tone="info" icon={Info}>{tn.note}</Callout>
          </div>
        </Card>
        <UnsavedChangesBar
          show={differs(s, loaded)}
          onDiscard={() => setS(loaded)}
          onSave={save}
          busy={busy}
          saveLabel={busy ? tn.saving : tn.save}
        />
      </div>

      {/* البريد الآلي — لوحة مستقلة بحالتها وحفظها الخاصين */}
      <EmailAutomationSettingsPanel />

      <Toast toast={toast} onDone={() => setToast(null)} />
    </div>
  );
}
