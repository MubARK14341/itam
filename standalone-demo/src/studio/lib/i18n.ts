// نظام i18n خفيف بلا مكتبات — قاموسان typed + أدوات مساعدة.
import { en, type Dict } from "./translations/en";
import { ar } from "./translations/ar";

export type Lang = "ar" | "en";
export type Theme = "light" | "dark";
export type { Dict };

export const LANGS: Lang[] = ["ar", "en"];
export const DEFAULT_LANG: Lang = "ar";
export const DEFAULT_THEME: Theme = "light";

export const LANG_COOKIE = "itam_lang";
export const THEME_COOKIE = "itam_theme";

export const dictionaries: Record<Lang, Dict> = { ar, en };

export function getDict(lang: Lang): Dict {
  return dictionaries[lang] ?? dictionaries[DEFAULT_LANG];
}

export function getDir(lang: Lang): "rtl" | "ltr" {
  return lang === "ar" ? "rtl" : "ltr";
}

export function normalizeLang(v: string | undefined | null): Lang {
  return v === "en" ? "en" : "ar";
}

export function normalizeTheme(v: string | undefined | null): Theme {
  return v === "dark" ? "dark" : "light";
}

// استبدال متغيّرات {x} داخل نص الترجمة بقيم فعلية.
export function interpolate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`));
}
