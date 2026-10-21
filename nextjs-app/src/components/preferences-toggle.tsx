"use client";

import { Moon, Sun } from "lucide-react";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { useHydrated } from "@/components/providers/use-hydrated";

// أزرار تبديل اللغة (ع / EN) والثيم (فاتح / داكن) — شريط أدوات مضغوط على الأسطح الفاتحة/الداكنة.
export function PreferencesToggle({ className = "" }: { className?: string }) {
  const { lang, theme, t, setLang, toggleTheme } = useAppPreferences();
  const hydrated = useHydrated();
  const seg = (active: boolean) =>
    `inline-flex h-8 min-w-9 items-center justify-center rounded-lg px-2 text-xs font-semibold transition-colors max-md:h-10 ${
      active ? "bg-surface text-fg shadow-pop" : "text-fg-2 hover:text-fg"
    }`;

  return (
    <div className={`flex items-center gap-1.5 ${className}`}>
      {/* تبديل اللغة */}
      <div className="flex items-center gap-0.5 rounded-control bg-sunk p-[3px]" role="group" aria-label={t.prefs.language}>
        <button type="button" disabled={!hydrated} onClick={() => setLang("ar")} aria-pressed={lang === "ar"} className={seg(lang === "ar")}>
          ع
        </button>
        <button type="button" disabled={!hydrated} onClick={() => setLang("en")} aria-pressed={lang === "en"} className={seg(lang === "en")}>
          EN
        </button>
      </div>

      {/* تبديل الثيم */}
      <button
        type="button"
        disabled={!hydrated}
        onClick={toggleTheme}
        title={theme === "dark" ? t.prefs.light : t.prefs.dark}
        aria-label={theme === "dark" ? t.prefs.light : t.prefs.dark}
        className="ui-button ui-button-ghost ui-button-md ui-button-icon"
      >
        {theme === "dark" ? <Sun aria-hidden="true" className="h-[18px] w-[18px]" /> : <Moon aria-hidden="true" className="h-[18px] w-[18px]" />}
      </button>
    </div>
  );
}
