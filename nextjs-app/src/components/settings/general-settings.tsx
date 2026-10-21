"use client";

import type { ReactNode } from "react";
import { Check, Languages, Moon, Sun, SunMoon } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/card";
import { StatusChip } from "@/components/ui/status-chip";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { DEFAULT_LANG, DEFAULT_THEME, type Lang, type Theme } from "@/lib/i18n";

// تبويب «عام» — معلومات النظام (قراءة فقط) + تفضيلات العرض (لغة/ثيم) لكل مستخدم عبر الكوكيز.
// لا يوجد جدول إعدادات عام؛ لا تُخزَّن قيم في القاعدة — احترامًا لنظام اللغة/الثيم القائم.
export function GeneralSettings() {
  const { t, lang, theme, setLang, setTheme } = useAppPreferences();
  const tg = t.settings.general;
  const tl = t.settings.ledger;

  const langLabel = (l: Lang) => (l === "ar" ? t.prefs.arabic : t.prefs.english);
  const themeLabel = (th: Theme) => (th === "dark" ? t.prefs.dark : t.prefs.light);

  const info: { label: string; value: ReactNode }[] = [
    { label: tg.systemName, value: t.app.title },
    { label: tg.defaultLanguage, value: langLabel(DEFAULT_LANG) },
    { label: tg.defaultTheme, value: themeLabel(DEFAULT_THEME) },
    { label: tg.environment, value: <StatusChip tone="warn">{tg.environmentPilot}</StatusChip> },
  ];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title={tg.preferences} description={tg.preferencesHint} />
        <div className="space-y-6 px-5 py-5">
          <div role="group" aria-labelledby="settings-pref-language">
            <p id="settings-pref-language" className="mb-2.5 flex items-center gap-1.5 text-[13px] font-medium text-fg-2">
              <Languages aria-hidden="true" className="h-4 w-4 text-muted" />{t.prefs.language}
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <ChoiceCard active={lang === "ar"} onClick={() => setLang("ar")} selectedLabel={tl.selected}
                title={t.prefs.arabic} hint={tl.languageArHint} glyph={<span lang="ar" className="font-display text-base font-semibold">ع</span>} />
              <ChoiceCard active={lang === "en"} onClick={() => setLang("en")} selectedLabel={tl.selected}
                title={t.prefs.english} hint={tl.languageEnHint} glyph={<span lang="en" className="font-display text-base font-semibold">Aa</span>} />
            </div>
          </div>
          <div role="group" aria-labelledby="settings-pref-theme">
            <p id="settings-pref-theme" className="mb-2.5 flex items-center gap-1.5 text-[13px] font-medium text-fg-2">
              <SunMoon aria-hidden="true" className="h-4 w-4 text-muted" />{t.prefs.theme}
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <ChoiceCard active={theme === "light"} onClick={() => setTheme("light")} selectedLabel={tl.selected}
                title={t.prefs.light} hint={tl.themeLightHint} glyph={<Sun aria-hidden="true" className="h-[18px] w-[18px]" />} />
              <ChoiceCard active={theme === "dark"} onClick={() => setTheme("dark")} selectedLabel={tl.selected}
                title={t.prefs.dark} hint={tl.themeDarkHint} glyph={<Moon aria-hidden="true" className="h-[18px] w-[18px]" />} />
            </div>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title={tg.section} description={tg.note} />
        <div className="px-5 py-5">
          <dl className="grid overflow-hidden rounded-xl border border-line sm:grid-cols-2">
            {info.map((row, i) => (
              <div
                key={row.label}
                className={`px-4 py-3 ${i > 0 ? "border-t border-line" : ""} ${i === 1 ? "sm:border-t-0" : ""} ${i % 2 === 1 ? "sm:border-s" : ""}`}
              >
                <dt className="text-xs text-muted">{row.label}</dt>
                <dd className="mt-1 text-sm font-medium text-fg">{row.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </Card>
    </div>
  );
}

function ChoiceCard({
  active, onClick, title, hint, glyph, selectedLabel,
}: {
  active: boolean; onClick: () => void; title: string; hint: string; glyph: ReactNode; selectedLabel: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex min-h-[64px] items-center gap-3 rounded-xl border px-3.5 py-3 text-start transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-ink ${
        active ? "border-brand bg-brand-soft" : "border-line-strong bg-surface hover:border-muted hover:bg-surface-2"
      }`}
    >
      <span className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] ${active ? "bg-surface text-brand-ink" : "bg-sunk text-fg-2"}`}>
        {glyph}
      </span>
      <span className="min-w-0 flex-1">
        <span className={`block text-sm font-semibold ${active ? "text-brand-ink" : "text-fg"}`}>{title}</span>
        <span className="mt-0.5 block text-xs text-muted">{hint}</span>
      </span>
      {active && (
        <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand text-brand-on">
          <Check aria-hidden="true" className="h-3.5 w-3.5" />
          <span className="sr-only">{selectedLabel}</span>
        </span>
      )}
    </button>
  );
}
