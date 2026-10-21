"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import {
  getDict, getDir, LANG_COOKIE, THEME_COOKIE,
  type Dict, type Lang, type Theme,
} from "@/lib/i18n";

interface PreferencesValue {
  lang: Lang;
  theme: Theme;
  dir: "rtl" | "ltr";
  t: Dict;
  setLang: (l: Lang) => void;
  toggleLang: () => void;
  setTheme: (th: Theme) => void;
  toggleTheme: () => void;
}

const Ctx = createContext<PreferencesValue | null>(null);

const ONE_YEAR = 60 * 60 * 24 * 365;
function writeCookie(name: string, value: string) {
  document.cookie = `${name}=${value};path=/;max-age=${ONE_YEAR};samesite=lax`;
}

// Provider مركزي للّغة والثيم.
// القيم الأولية تأتي من الخادم (مقروءة من cookie) لتفادي الوميض و hydration mismatch:
// أول render على العميل يطابق ما رسمه الخادم تمامًا.
export function AppPreferencesProvider({
  initialLang, initialTheme, children,
}: {
  initialLang: Lang;
  initialTheme: Theme;
  children: React.ReactNode;
}) {
  const [lang, setLangState] = useState<Lang>(initialLang);
  const [theme, setThemeState] = useState<Theme>(initialTheme);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    writeCookie(LANG_COOKIE, l);
    try { localStorage.setItem(LANG_COOKIE, l); } catch { /* ignore */ }
    const el = document.documentElement;
    el.lang = l;
    el.dir = getDir(l);
  }, []);

  const setTheme = useCallback((th: Theme) => {
    setThemeState(th);
    writeCookie(THEME_COOKIE, th);
    try { localStorage.setItem(THEME_COOKIE, th); } catch { /* ignore */ }
    const el = document.documentElement;
    el.classList.toggle("dark", th === "dark");
    el.style.colorScheme = th;
  }, []);

  const value = useMemo<PreferencesValue>(() => ({
    lang,
    theme,
    dir: getDir(lang),
    t: getDict(lang),
    setLang,
    toggleLang: () => setLang(lang === "ar" ? "en" : "ar"),
    setTheme,
    toggleTheme: () => setTheme(theme === "dark" ? "light" : "dark"),
  }), [lang, theme, setLang, setTheme]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAppPreferences(): PreferencesValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAppPreferences must be used within AppPreferencesProvider");
  return ctx;
}

// hook مختصر للترجمة: يُعيد القاموس الحالي واللغة والاتجاه.
export function useT() {
  const { t, lang, dir } = useAppPreferences();
  return { t, lang, dir };
}

export function useLanguage() {
  const { lang, dir, setLang, toggleLang } = useAppPreferences();
  return { lang, dir, setLang, toggleLang };
}

export function useTheme() {
  const { theme, setTheme, toggleTheme } = useAppPreferences();
  return { theme, setTheme, toggleTheme };
}
