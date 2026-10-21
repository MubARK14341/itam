"use client";

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Box, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { useHydrated } from "@/components/providers/use-hydrated";
import { EquipmentPhoto } from "@/components/assets/equipment-photo";

/** Brand lock-up used on every full-bleed (no app shell) page. */
export function AuthBrand({ subtitle }: { subtitle?: ReactNode }) {
  const { t } = useAppPreferences();
  return (
    <div className="flex min-w-0 items-center gap-3">
      <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand text-brand-on">
        <Box aria-hidden="true" className="h-[21px] w-[21px]" strokeWidth={1.6} />
      </span>
      <span className="min-w-0 leading-tight">
        <span className="block truncate font-display text-lg font-semibold text-fg">{t.nav.brand}</span>
        <span className="mt-0.5 block truncate text-xs text-muted">{subtitle ?? t.nav.brandSub}</span>
      </span>
    </div>
  );
}

/** Language (ع / EN) and theme toggles available before sign-in. */
export function AuthPrefs({ className = "" }: { className?: string }) {
  const { t, lang, theme, setLang, toggleTheme } = useAppPreferences();
  const hydrated = useHydrated();
  const item = "ui-seg-item min-w-10 justify-center px-2.5 text-xs font-semibold max-md:min-h-10";
  return (
    <div className={`flex shrink-0 items-center gap-1.5 ${className}`}>
      <div className="ui-seg" role="group" aria-label={t.prefs.language}>
        <button type="button" lang="ar" disabled={!hydrated} onClick={() => setLang("ar")} aria-pressed={lang === "ar"} className={item}>ع</button>
        <button type="button" lang="en" disabled={!hydrated} onClick={() => setLang("en")} aria-pressed={lang === "en"} className={item}>EN</button>
      </div>
      <Button
        type="button"
        disabled={!hydrated}
        variant="ghost"
        size="icon"
        onClick={toggleTheme}
        aria-label={theme === "dark" ? t.prefs.light : t.prefs.dark}
        className="max-md:h-11 max-md:w-11"
      >
        {theme === "dark" ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
      </Button>
    </div>
  );
}

export type HeroFeature = { icon: LucideIcon; title: string; desc: string };

/** Studio product stage shared by the authentication surfaces. */
export function AuthHero({
  label, chip, title, description, features, children,
}: {
  label: string;
  chip: ReactNode;
  title: ReactNode;
  description: ReactNode;
  features: HeroFeature[];
  children?: ReactNode;
}) {
  return (
    <section
      aria-label={label}
      className="login-story relative flex-col justify-center overflow-hidden rounded-[22px] bg-[rgb(var(--hero))] px-8 py-10 text-[rgb(var(--hero-ink))] xl:px-10"
    >
      <span className="inline-flex items-center gap-2 self-start text-xs font-medium text-[rgb(var(--hero-muted))]">
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-brand" />
        {chip}
      </span>
      <h2 className="mt-5 max-w-[420px] font-display text-[32px] font-medium leading-[1.6] tracking-[-0.02em]">{title}</h2>
      <p className="mt-3 max-w-[400px] text-sm leading-[1.9] text-[rgb(var(--hero-muted))]">{description}</p>
      <div aria-hidden="true" className="my-7">
        <EquipmentPhoto templateId="laptop" size="stage" unframed />
      </div>
      {children && <div className="relative">{children}</div>}
      {features.length > 0 && <ul className="mt-6 grid gap-4 border-t border-[rgb(var(--hero-ink)/0.18)] pt-6">
        {features.map(({ title: featureTitle, desc }) => (
          <li key={featureTitle} className="flex min-w-0 gap-3">
            <span aria-hidden="true" className="mt-2 h-1 w-1 shrink-0 rounded-full bg-brand" />
            <div className="min-w-0">
              <p className="text-sm font-semibold">{featureTitle}</p>
              <p className="text-[12.5px] text-[rgb(var(--hero-muted))]">{desc}</p>
            </div>
          </li>
        ))}
      </ul>}
    </section>
  );
}

/** Numbered vertical flow shown inside the hero on the registration pages. */
export function HeroFlow({ title, stepLabel, steps }: { title: string; stepLabel: string; steps: { title: string; desc: string }[] }) {
  return (
    <div className="w-full border-t border-[rgb(var(--hero-ink)/0.18)] pt-5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[13.5px] font-semibold">{title}</span>
        <span className="text-xs tabular-nums text-[rgb(var(--hero-muted))]">{stepLabel}</span>
      </div>
      <ol className="mt-4 flex flex-col">
        {steps.map((step, index) => {
          const current = index === 0;
          const last = index === steps.length - 1;
          return (
            <li key={step.title} aria-current={current ? "step" : undefined} className="grid grid-cols-[30px_minmax(0,1fr)] gap-x-3.5">
              <span className="flex flex-col items-center">
                <span className={`inline-flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full border text-[13px] font-bold tabular-nums ${current ? "border-[rgb(var(--hero-ink))] bg-[rgb(var(--hero-ink))] text-[rgb(var(--hero))]" : "border-[rgb(var(--hero-ink)/0.22)] text-[rgb(var(--hero-muted))]"}`}>{index + 1}</span>
                {!last && <span aria-hidden="true" className="my-1 w-0.5 flex-1 rounded bg-[rgb(var(--hero-ink)/0.14)]" />}
              </span>
              <span className={`block leading-[1.45] ${last ? "" : "pb-[18px]"}`}>
                <span className="block text-[14.5px] font-semibold">{step.title}</span>
                <span className="mt-0.5 block text-[12.5px] text-[rgb(var(--hero-muted))]">{step.desc}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
