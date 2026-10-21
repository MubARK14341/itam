"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Power, RotateCcw, Info, TriangleAlert, Eye, Map, Check, Save } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/card";
import { Button, buttonClass } from "@/components/ui/button";
import { StatusChip } from "@/components/ui/status-chip";
import { Toast, type ToastState } from "@/components/ui/toast";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { useSession, isAdmin } from "@/lib/session";
import { getUnlockCountsByLevel, type ExposureLevel } from "@/lib/feature-exposure";
import {
  getFeatureExposureSettings, updateFeatureExposureSettings,
  DEFAULT_FEATURE_EXPOSURE_SETTINGS, type FeatureExposureSettings,
} from "@/lib/feature-exposure-settings";
import { Callout, SectionLoading, SwitchRow, UnsavedChangesBar } from "@/components/settings/settings-ui";

// تبويب «الإظهار التدريجي» — admin فقط (الفلترة في صفحة الإعدادات + RLS الكتابة admin حصرًا).
// يتحكم بالنسبة الموحدة لكل الموظفين؛ طبقة عرض فقط — لا يمس أي صلاحية (RBAC/RLS كما هي).
// الموظفون يلتقطون النسبة الجديدة عند تحديث/فتح الصفحة التالي (بدون realtime عمدًا).

const LEVELS: ExposureLevel[] = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

export function FeatureRolloutSettings() {
  const { role } = useSession();
  const { t } = useAppPreferences();
  const tr = t.settings.featureRollout;
  const [s, setS] = useState<FeatureExposureSettings>(DEFAULT_FEATURE_EXPOSURE_SETTINGS);
  const [saved, setSaved] = useState<FeatureExposureSettings>(DEFAULT_FEATURE_EXPOSURE_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirmLower, setConfirmLower] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);

  useEffect(() => {
    getFeatureExposureSettings().then((v) => { setS(v); setSaved(v); setLoading(false); });
  }, []);

  // عدد الميزات التي تنفتح عند كل مستوى (منظور الفني — الدور المرجعي للرحلة).
  const counts = useMemo(() => getUnlockCountsByLevel("technician"), []);

  const levelMeta: Record<ExposureLevel, { title: string; desc: string }> = {
    10: tr.levels.l10, 20: tr.levels.l20, 30: tr.levels.l30, 40: tr.levels.l40,
    50: tr.levels.l50, 60: tr.levels.l60, 70: tr.levels.l70, 80: tr.levels.l80,
    90: tr.levels.l90, 100: tr.levels.l100,
  };

  // خفض النسبة = ميزات ستختفي عن الموظفين ⇒ تأكيد من ضغطتين قبل الحفظ.
  const isLowering =
    s.level != null && saved.level != null && s.level < saved.level;

  function select(level: ExposureLevel | null) {
    setConfirmLower(false);
    setS((p) => ({ ...p, level }));
  }

  async function save() {
    if (isLowering && !confirmLower) {
      setConfirmLower(true);
      return;
    }
    setBusy(true);
    const err = await updateFeatureExposureSettings(s);
    setBusy(false);
    setConfirmLower(false);
    if (err) {
      setToast({ type: "error", message: tr.error + err });
    } else {
      setSaved(s);
      setToast({ type: "success", message: tr.saved });
    }
  }

  // حارس دفاعي: التبويب مفلتر أصلًا لـ admin في صفحة الإعدادات.
  if (!isAdmin(role)) return null;
  if (loading) return <SectionLoading />;

  const dirty = s.enabled !== saved.enabled || s.level !== saved.level;
  const saveLabel = busy ? tr.saving : confirmLower ? tr.confirmSave : tr.save;

  return (
    <div className="space-y-4">
      {confirmLower && (
        <Callout tone="warn" icon={TriangleAlert} role="alert">{tr.lowerWarning}</Callout>
      )}

      <Card>
        <CardHeader
          title={t.settings.tabs.featureRollout}
          description={tr.subtitle}
          actions={<Button onClick={save} disabled={busy || !dirty}><Save aria-hidden="true" />{saveLabel}</Button>}
        />
        <div className="px-5 py-2">
          {/* التفعيل */}
          <SwitchRow
            icon={Power}
            label={tr.enabledLabel}
            hint={tr.enabledHint}
            checked={s.enabled}
            onChange={(v) => { setConfirmLower(false); setS((p) => ({ ...p, enabled: v })); }}
          />
        </div>
        {!s.enabled && (
          <p className="border-t border-line px-5 py-3 text-[13px] text-muted">{tr.disabledNote}</p>
        )}
      </Card>

      {/* النسبة الموحدة */}
      <Card className={!s.enabled ? "opacity-60" : ""}>
        <CardHeader title={tr.levelTitle} description={tr.levelHint} />
        <div className="space-y-4 px-5 py-5">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <div>
              <p className="text-[12.5px] text-muted">{tr.currentBadge}</p>
              <div className="mt-0.5 flex items-baseline gap-2.5">
                <span className="font-display text-[34px] font-semibold leading-none tabular-nums text-fg" dir="ltr">
                  {s.level != null ? `${s.level}%` : "—"}
                </span>
                <span className="text-sm font-semibold text-fg-2">
                  {s.level != null ? levelMeta[s.level].title : tr.defaultPerRole}
                </span>
              </div>
            </div>
            <div aria-hidden="true" className="grid min-w-[200px] flex-1 grid-cols-10 gap-1">
              {LEVELS.map((lvl) => (
                <span key={lvl} className={`h-2 rounded-full ${s.level != null && lvl <= s.level ? "bg-brand" : "bg-sunk"}`} />
              ))}
            </div>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {LEVELS.map((lvl) => (
              <button
                key={lvl}
                type="button"
                disabled={!s.enabled || busy}
                onClick={() => select(lvl)}
                aria-pressed={s.level === lvl}
                className={`min-h-9 min-w-[3.25rem] rounded-control border px-3 text-[13px] font-semibold tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-ink disabled:cursor-not-allowed max-md:min-h-11 ${
                  s.level === lvl
                    ? "border-brand bg-brand text-brand-on"
                    : "border-line-strong bg-surface text-fg-2 hover:border-muted hover:text-fg"
                }`}
                dir="ltr"
              >
                {lvl}%
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="ghost"
              size="sm"
              disabled={!s.enabled || busy || s.level == null}
              onClick={() => select(null)}
            >
              <RotateCcw aria-hidden="true" />{tr.resetToDefault}
            </Button>
            <span className="text-xs text-muted">{tr.adminAlwaysFull}</span>
          </div>
        </div>
      </Card>

      {/* رحلة النظام — ما الذي ينفتح عند كل نسبة */}
      <Card>
        <CardHeader
          title={<span className="inline-flex items-center gap-2"><Map aria-hidden="true" className="h-[18px] w-[18px] text-muted" />{tr.timelineTitle}</span>}
          description={tr.timelineHint}
        />
        <ol className="divide-y divide-line">
          {LEVELS.map((lvl) => {
            const current = s.level === lvl;
            const unlocked = s.level != null && lvl <= s.level;
            return (
              <li
                key={lvl}
                className={`flex items-center gap-3 px-5 py-3 ${current ? "bg-brand-soft" : ""}`}
              >
                <span
                  className={`flex h-9 w-12 shrink-0 items-center justify-center rounded-lg text-xs font-semibold tabular-nums ${
                    current
                      ? "bg-brand text-brand-on"
                      : unlocked
                        ? "bg-ok-soft text-ok"
                        : "bg-sunk text-muted"
                  }`}
                  dir="ltr"
                >
                  {lvl}%
                </span>
                <div className="min-w-0 flex-1">
                  <p className={`flex flex-wrap items-center gap-2 text-sm font-semibold ${unlocked ? "text-fg" : "text-fg-2"}`}>
                    {levelMeta[lvl].title}
                    {current && (
                      <StatusChip tone="info" size="sm">
                        <Check aria-hidden="true" className="h-3 w-3" />{tr.currentBadge}
                      </StatusChip>
                    )}
                  </p>
                  <p className="mt-0.5 text-[12.5px] leading-5 text-muted">{levelMeta[lvl].desc}</p>
                </div>
                {counts[lvl] > 0 && (
                  <span className="ui-count hidden shrink-0 sm:inline-flex">
                    {tr.featuresCount.replace("{count}", String(counts[lvl]))}
                  </span>
                )}
                <Link
                  href={`/dashboard?exposure=${lvl}&asRole=technician`}
                  className={buttonClass("ghost", "sm", "shrink-0 text-brand-ink")}
                >
                  <Eye aria-hidden="true" />{tr.previewLink}
                </Link>
              </li>
            );
          })}
        </ol>
      </Card>

      <Callout tone="info" icon={Info}>{tr.note}</Callout>

      <UnsavedChangesBar
        show={dirty}
        onDiscard={() => { setConfirmLower(false); setS(saved); }}
        onSave={save}
        busy={busy}
        saveLabel={saveLabel}
      />

      <Toast toast={toast} onDone={() => setToast(null)} />
    </div>
  );
}
