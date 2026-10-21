// ============================================================================
//  إعدادات الإظهار التدريجي (Phase 2) — قراءة/كتابة صف feature_exposure_settings.
//  • ملف مستقل عن محرك feature-exposure.ts عمدًا: المحرك يبقى نقيًا (بلا supabase)
//    لمستهلكيه الـ26؛ هذا الملف وحده يتصل بالقاعدة.
//  • level = النسبة الموحدة لكل الأدوار غير admin (10..100 بخطوة 10)؛
//    NULL = ثوابت Phase 1 لكل دور (سلوك اليوم بالضبط).
//  • القراءة فاشلة-بأمان: أي خطأ/صف مفقود ⇒ الافتراضي = سلوك اليوم (نمط notifications.ts).
//  • طبقة عرض فقط — لا تلمس RBAC/RLS؛ admin مثبّت على 100 دائمًا.
// ============================================================================
import { createClient } from "@/lib/supabase/client";
import type { Role } from "@/lib/session";
import { getExposureLevelForRole, type ExposureLevel } from "@/lib/feature-exposure";

const supabase = () => createClient();

export interface FeatureExposureSettings {
  enabled: boolean;
  // NULL = الوضع الافتراضي (ثوابت الأدوار Phase 1).
  level: ExposureLevel | null;
}

export const DEFAULT_FEATURE_EXPOSURE_SETTINGS: FeatureExposureSettings = {
  enabled: true,
  level: null,
};

export const SETTINGS_ID = "main";
export const SETTINGS_COLS = "enabled,level";

// تطبيع أي قيمة إلى مستوى صحيح: تقريب لأقرب مضاعف 10 ضمن 10..100؛ غير الرقمي ⇒ null.
export function clampExposureLevel(v: unknown): ExposureLevel | null {
  const n = Number(v);
  if (v == null || Number.isNaN(n)) return null;
  const snapped = Math.min(100, Math.max(10, Math.round(n / 10) * 10));
  return snapped as ExposureLevel;
}

// يقرأ الإعدادات؛ يتدرّج بأمان إلى الافتراضي (= سلوك اليوم) إن غاب الجدول/الصف أو مُنعت القراءة.
export async function getFeatureExposureSettings(): Promise<FeatureExposureSettings> {
  try {
    const { data, error } = await supabase()
      .from("feature_exposure_settings").select(SETTINGS_COLS).eq("id", SETTINGS_ID).maybeSingle();
    if (error || !data) return { ...DEFAULT_FEATURE_EXPOSURE_SETTINGS };
    return {
      enabled: data.enabled !== false,
      level: clampExposureLevel(data.level),
    };
  } catch {
    return { ...DEFAULT_FEATURE_EXPOSURE_SETTINGS };
  }
}

// تحديث الإعدادات (admin فقط عبر RLS). updated_by/updated_at يُختمان بالخادم.
export async function updateFeatureExposureSettings(p: FeatureExposureSettings): Promise<string | null> {
  const { error } = await supabase().from("feature_exposure_settings").upsert({
    id: SETTINGS_ID,
    enabled: p.enabled,
    level: clampExposureLevel(p.level),
  });
  return error?.message ?? null;
}

// الدالة المركزية لمستوى العرض الفعّال:
//   admin ⇒ 100 دائمًا | بلا دور ⇒ 10 | إعدادات غائبة (تحميل/خطأ) أو level=NULL ⇒ ثوابت Phase 1
//   | enabled=false ⇒ 100 (كل شيء ظاهر حسب الدور، مطابق لتعطيل النظام) | غير ذلك ⇒ النسبة الموحدة.
export function resolveEffectiveLevel(
  role: Role,
  settings: FeatureExposureSettings | null,
): ExposureLevel {
  if (role === "admin") return 100;
  if (!role) return 10;
  if (!settings) return getExposureLevelForRole(role);
  if (!settings.enabled) return 100;
  if (settings.level == null) return getExposureLevelForRole(role);
  return settings.level;
}
