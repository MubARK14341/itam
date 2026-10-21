import type { AssetStatus } from "./types";
import type { Lang } from "./i18n";
import { ASSET_STATUS_TONE, REQUEST_STATUS_TONE, toneStyles } from "./tone";

export const STATUS_AR: Record<AssetStatus, string> = {
  available: "متاح",
  reserved: "محجوز",
  in_maintenance: "في الصيانة",
};

export const STATUS_STYLE: Record<AssetStatus, string> = toneStyles(ASSET_STATUS_TONE);

// ===== حالات طلب العميل (Customer Request) — ألوان الشارات (مفاتيح بقيمة القاعدة) =====
export const REQUEST_STATUS_STYLE: Record<string, string> = toneStyles(REQUEST_STATUS_TONE);

// المنسّقات تقبل اللغة اختياريًا (الافتراضي العربية حفاظًا على السلوك القائم).
// الإنجليزية تستخدم أرقامًا لاتينية وتقويمًا ميلاديًا بصيغة en.
function localeFor(lang: Lang): string {
  // أرقام لاتينية في اللغتين (اتفاقية المشروع: عدّادات/معرّفات/تواريخ لاتينية دائمًا) —
  // نفرض nu-latn للعربية مع التقويم الميلادي بدل ar-SA الذي يُخرج أرقامًا هندية.
  return lang === "en" ? "en-US" : "ar-SA-u-ca-gregory-nu-latn";
}

const REQUEST_TIME_ZONE = "Asia/Riyadh";

function parsedDate(value: string, dateOnly: boolean): Date | null {
  const date = new Date(dateOnly ? `${value}T00:00:00Z` : value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateParts(
  value: string,
  lang: Lang,
  includeTime: boolean,
): Record<string, string> | null {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const date = parsedDate(value, dateOnly);
  if (!date) return null;
  const formatter = new Intl.DateTimeFormat(localeFor(lang), {
    timeZone: dateOnly ? "UTC" : REQUEST_TIME_ZONE,
    day: "numeric",
    month: lang === "en" ? "short" : "long",
    year: "numeric",
    ...(includeTime ? {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    } : {}),
  });
  return Object.fromEntries(
    formatter.formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
}

export function formatSAR(v: number | null | undefined, lang: Lang = "ar"): string {
  if (v == null) return "—";
  // عملة موحّدة عبر الواجهة: «ر.س» بالعربية و«SAR» بالإنجليزية.
  // (DATA-2) نُظهر الكسور حتى منزلتين بلا أصفار زائدة: 1234.56 → «1,234.56» و 1000 → «1,000».
  // (I18N-3) أرقام لاتينية دائمًا عبر nu-latn في المسار العربي.
  const locale = lang === "en" ? "en-US" : "ar-SA-u-nu-latn";
  return new Intl.NumberFormat(locale, { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(v) + (lang === "en" ? " SAR" : " ر.س");
}

// عدد المرّات بصيغة عربية سليمة (مرة واحدة / مرتان / ٣-١٠ مرات / ١١+ مرة) — الإنجليزية time/times.
export function formatTimes(n: number, lang: Lang = "ar"): string {
  if (lang === "en") return `${n} ${n === 1 ? "time" : "times"}`;
  if (n === 1) return "مرة واحدة";
  if (n === 2) return "مرتان";
  if (n <= 10) return `${n} مرات`;
  return `${n} مرة`; // تمييز العدد ١١ فأكثر يكون مفردًا منصوبًا
}

// كمية + وحدة مُترجمة (مثال: «0 قطعة» / «18 قطعة») — يرجع للقيمة الخام إن كانت الوحدة غير معروفة.
export function formatQtyUnit(
  qty: number | null | undefined,
  unit: string | null | undefined,
  units?: Record<string, string>,
): string {
  const n = qty ?? 0;
  const label = unit ? (units?.[unit] ?? unit) : "";
  return label ? `${n} ${label}` : String(n);
}

export function formatDate(d: string | null | undefined, lang: Lang = "ar"): string {
  if (!d) return "—";
  const parts = dateParts(d, lang, false);
  if (!parts) return "—";
  return `${parts.day} ${parts.month} ${parts.year}`;
}

let riyadhDateKeyFormatter: Intl.DateTimeFormat | undefined;

export function dateKeyInTimeZone(date: Date = new Date(), timeZone = "Asia/Riyadh"): string {
  const formatter = timeZone === REQUEST_TIME_ZONE && riyadhDateKeyFormatter
    ? riyadhDateKeyFormatter
    : new Intl.DateTimeFormat("en-US", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    });
  if (timeZone === REQUEST_TIME_ZONE) riyadhDateKeyFormatter = formatter;
  const parts = formatter.formatToParts(date);
  const value = (kind: "year" | "month" | "day") =>
    parts.find((part) => part.type === kind)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export function formatDateTime(d: string | null | undefined, lang: Lang = "ar"): string {
  if (!d) return "—";
  const parts = dateParts(d, lang, true);
  if (!parts) return "—";
  const date = `${parts.day} ${parts.month} ${parts.year}`;
  const time = `${parts.hour}:${parts.minute} ${parts.dayPeriod}`;
  return lang === "ar" ? `${date}، ${time}` : `${date}, ${time}`;
}

// صيغة عربية سليمة العدّ لـ«قبل N وحدة» (مفرد/مثنى/جمع ٣-١٠/مفرد منصوب ١١+) — الأرقام لاتينية دائمًا.
function arAgo(n: number, one: string, two: string, few: string, many: string): string {
  if (n === 1) return `قبل ${one}`;
  if (n === 2) return `قبل ${two}`;
  if (n <= 10) return `قبل ${n} ${few}`;
  return `قبل ${n} ${many}`;
}

// وقت نسبي مختصر لِلوحة المعلومات (ActivityFeed) — أرقام لاتينية موحّدة في اللغتين.
export function formatRelative(
  d: string | null | undefined,
  lang: Lang = "ar",
  referenceMs?: number,
): string {
  if (!d) return "—";
  const then = new Date(d).getTime();
  if (Number.isNaN(then)) return "—";
  const now = referenceMs === undefined ? Date.now() : referenceMs;
  if (!Number.isFinite(now)) return "—";
  const sec = Math.max(0, Math.round((now - then) / 1000));
  const en = lang === "en";
  if (sec < 60) return en ? "just now" : "الآن";
  const m = Math.floor(sec / 60);
  if (m < 60) return en ? `${m}m ago` : arAgo(m, "دقيقة", "دقيقتين", "دقائق", "دقيقة");
  const h = Math.floor(m / 60);
  if (h < 24) return en ? `${h}h ago` : arAgo(h, "ساعة", "ساعتين", "ساعات", "ساعة");
  const day = Math.floor(h / 24);
  if (day < 7) return en ? `${day}d ago` : arAgo(day, "يوم", "يومين", "أيام", "يومًا");
  const w = Math.floor(day / 7);
  if (day < 30) return en ? `${w}w ago` : arAgo(w, "أسبوع", "أسبوعين", "أسابيع", "أسبوعًا");
  const mo = Math.floor(day / 30);
  if (day < 365) return en ? `${mo}mo ago` : arAgo(mo, "شهر", "شهرين", "أشهر", "شهرًا");
  const y = Math.floor(day / 365);
  return en ? `${y}y ago` : arAgo(y, "سنة", "سنتين", "سنوات", "سنة");
}

// حجم ملف بوحدات B/KB/MB (أرقام لاتينية — يُعرض بـ dir="ltr" عند الحاجة).
export function formatBytes(n: number | null | undefined): string {
  if (n == null || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
