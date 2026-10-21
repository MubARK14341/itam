"use client";

import { useCallback, useEffect, useState } from "react";
import { Inbox, MailCheck, RefreshCw, Save, Send, ShieldAlert } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { KpiBand } from "@/components/ui/kpi-band";
import { StatusChip } from "@/components/ui/status-chip";
import { Toast, type ToastState } from "@/components/ui/toast";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import type { Tone } from "@/lib/tone";
import {
  emailDeliveryAction, enqueueStagingTestEmail, getEmailAutomationSettings, getEmailDeliveryOverview, listRecentEmailDeliveries,
  updateEmailAutomationSettings, type EmailAutomationSettings, type EmailDeliveryOverview, type RecentEmailDelivery,
} from "@/lib/email-automation";
import { Callout, SectionLoading, SwitchRow, UnsavedChangesBar, differs } from "@/components/settings/settings-ui";

// لون الحالة فقط (النص يبقى قيمة الحالة كما تعود من الخادم).
const DELIVERY_TONE: Record<string, Tone> = {
  sent: "ok", delivered: "ok", pending: "warn", failed: "bad", suppressed: "neu", cancelled: "neu", canceled: "neu",
};

export function EmailAutomationSettingsPanel() {
  const { t } = useAppPreferences();
  const copy = t.notifications.emailAutomation;
  const [settings, setSettings] = useState<EmailAutomationSettings | null>(null);
  // لقطة القيم المحمّلة — لشريط «تغييرات غير محفوظة» فقط (واجهة).
  const [loaded, setLoaded] = useState<EmailAutomationSettings | null>(null);
  const [overview, setOverview] = useState<EmailDeliveryOverview | null>(null);
  const [recent, setRecent] = useState<RecentEmailDelivery[]>([]);
  const [busy, setBusy] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);

  const load = useCallback(async () => {
    const [s, o, r] = await Promise.all([getEmailAutomationSettings(), getEmailDeliveryOverview(), listRecentEmailDeliveries()]);
    if (s.error || o.error || r.error) setToast({ type: "error", message: copy.loadError });
    setSettings(s.data); setLoaded(s.data); setOverview(o.data); setRecent(r.rows);
  }, [copy.loadError]);
  useEffect(() => { void load(); }, [load]);
  const toggle = (key: "email_enabled" | "test_mode" | "daily_digest_enabled") =>
    setSettings((v) => v ? { ...v, [key]: !v[key] } : v);
  const save = async () => {
    if (!settings) return;
    setBusy(true);
    const { data, error } = await updateEmailAutomationSettings(settings);
    setBusy(false);
    if (error) setToast({ type: "error", message: copy.saveError });
    else { setSettings(data); setToast({ type: "success", message: copy.saved }); await load(); }
  };
  const act = async (id: string, action: "retry" | "cancel") => {
    const error = await emailDeliveryAction(id, action);
    setToast(error ? { type: "error", message: copy.actionError } : { type: "success", message: copy.actionDone });
    if (!error) await load();
  };
  const sendStagingTest = async () => {
    setTestBusy(true);
    const error = await enqueueStagingTestEmail();
    setTestBusy(false);
    setToast(error ? { type: "error", message: copy.testSendError } : { type: "success", message: copy.testSendQueued });
    if (!error) await load();
  };
  if (!settings) return <SectionLoading />;
  const stats: { key: string; label: string; value: number; tone?: Tone }[] = [
    { key: "sent", label: copy.sent, value: overview?.sent_today ?? 0 },
    { key: "delivered", label: copy.delivered, value: overview?.delivered_today ?? 0, tone: "ok" },
    { key: "pending", label: copy.pending, value: overview?.pending ?? 0, tone: "warn" },
    { key: "failed", label: copy.failed, value: overview?.failed ?? 0, tone: "bad" },
    { key: "suppressed", label: copy.suppressed, value: overview?.suppressed ?? 0 },
  ];
  const dirty = loaded != null && differs(settings, loaded);
  return <div className="space-y-4">
    <div>
      <Card>
        <CardHeader
          title={<span className="inline-flex items-center gap-2"><MailCheck aria-hidden="true" className="h-[18px] w-[18px] text-brand" />{copy.title}</span>}
          description={copy.subtitle}
          actions={<>
            <Button variant="outline" onClick={() => void sendStagingTest()} disabled={testBusy || !settings.test_mode}>{testBusy ? copy.testSending : <><Send aria-hidden="true" />{copy.sendTest}</>}</Button>
            <Button onClick={() => void save()} disabled={busy}><Save aria-hidden="true" />{busy ? copy.saving : copy.save}</Button>
          </>}
        />
        <div className="space-y-4 px-5 py-5">
          <Callout tone="warn" icon={ShieldAlert}>{copy.testNotice}</Callout>
          <div>
            <SwitchRow label={copy.enabled} ariaLabel={copy.enabled} checked={settings.email_enabled} onChange={() => toggle("email_enabled")} />
            <SwitchRow label={copy.testMode} ariaLabel={copy.testMode} checked={settings.test_mode} onChange={() => toggle("test_mode")} />
            <SwitchRow label={copy.dailyDigest} ariaLabel={copy.dailyDigest} checked={settings.daily_digest_enabled} onChange={() => toggle("daily_digest_enabled")}
              hint={<>{copy.schedule}: <span dir="ltr" className="font-semibold tabular-nums text-fg-2 [unicode-bidi:isolate]">{settings.digest_time}</span> · {copy.workdays}</>} />
          </div>
        </div>
      </Card>
      <UnsavedChangesBar
        show={dirty}
        onDiscard={() => { if (loaded) setSettings(loaded); }}
        onSave={() => void save()}
        busy={busy}
        saveLabel={busy ? copy.saving : copy.save}
      />
    </div>
    <KpiBand items={stats} label={copy.title} className="lg:!grid-cols-5" />
    <Card>
      <CardHeader
        title={copy.recent}
        actions={<Button variant="outline" size="sm" onClick={() => void load()}><RefreshCw aria-hidden="true" />{copy.refresh}</Button>}
      />
      {recent.length === 0 ? (
        <EmptyState compact icon={Inbox} title={copy.none} />
      ) : (
        <ul className="divide-y divide-line">
          {recent.map((item) => <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
            <div className="min-w-0">
              <p className="font-medium text-fg">{item.template_key}</p>
              <p className="text-xs text-muted [unicode-bidi:isolate]" dir="ltr">{item.recipient_email}</p>
              {item.safe_error && <p className="mt-0.5 text-xs text-bad">{item.safe_error}</p>}
            </div>
            <div className="flex items-center gap-2">
              <StatusChip tone={DELIVERY_TONE[item.status] ?? "neu"} size="sm">{item.status}</StatusChip>
              {item.status === "failed" && <Button size="sm" variant="outline" onClick={() => void act(item.id, "retry")}>{copy.retry}</Button>}
              {item.status === "pending" && <Button size="sm" variant="outline" onClick={() => void act(item.id, "cancel")}>{copy.cancel}</Button>}
            </div>
          </li>)}
        </ul>
      )}
    </Card>
    <Toast toast={toast} onDone={() => setToast(null)} />
  </div>;
}
