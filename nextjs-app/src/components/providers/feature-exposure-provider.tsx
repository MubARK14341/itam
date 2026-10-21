"use client";

// مزوّد «الإظهار التدريجي»: يحسب مستوى العرض الفعّال للدور الحالي ويوفّر isVisible.
// طبقة عرض فقط — لا يلمس RBAC/RLS/RPC. عند غياب المزوّد أو تعطيل النظام،
// كل شيء يظهر (fail-open) لأن الإخفاء الخاطئ أخطر من الإظهار: الأمان في الخادم.
//
// وضع المعاينة (admin فقط، بلا أي تخزين دائم):
//   /dashboard?exposure=20&asRole=technician
// يُحفظ في sessionStorage فقط (يزول بإغلاق التبويب) ويظهر شريط صغير لإنهائه.
// المعاينة تغيّر «طبقة الإظهار» فقط — فحوص الدور الحقيقية (canWrite...) تبقى بدور admin الفعلي.

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useSession, type Role } from "@/lib/session";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import {
  isFeatureVisible,
  getExposureLevelForRole,
  EXPOSURE_ENABLED,
  type ExposureLevel,
  type FeatureKey,
  type FeatureVisibilityContext,
  type KnownRole,
  FEATURE_EXPOSURE_PREVIEW_ROLES,
} from "@/lib/feature-exposure";
import {
  getFeatureExposureSettings,
  resolveEffectiveLevel,
  type FeatureExposureSettings,
} from "@/lib/feature-exposure-settings";

const PREVIEW_STORAGE_KEY = "itam_exposure_preview";
const VALID_LEVELS: ExposureLevel[] = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

interface ExposurePreview {
  level?: ExposureLevel;
  asRole?: KnownRole;
}

interface FeatureExposureValue {
  // المستوى الفعّال المطبق على طبقة الإظهار الآن.
  level: ExposureLevel;
  // الدور المستخدم لحساب الإظهار (يختلف عن الدور الحقيقي فقط أثناء المعاينة).
  exposureRole: Role;
  previewActive: boolean;
  isVisible: (key: FeatureKey, context?: FeatureVisibilityContext) => boolean;
  clearPreview: () => void;
}

// افتراضي fail-open: بدون مزوّد، كل شيء ظاهر — مطابق لسلوك اليوم.
const FeatureExposureCtx = createContext<FeatureExposureValue>({
  level: 100,
  exposureRole: null,
  previewActive: false,
  isVisible: () => true,
  clearPreview: () => {},
});

function parsePreview(raw: { level?: unknown; asRole?: unknown } | null): ExposurePreview | null {
  if (!raw) return null;
  const preview: ExposurePreview = {};
  const lvl = Number(raw.level);
  if (VALID_LEVELS.includes(lvl as ExposureLevel)) preview.level = lvl as ExposureLevel;
  if (typeof raw.asRole === "string" && FEATURE_EXPOSURE_PREVIEW_ROLES.includes(raw.asRole as KnownRole)) {
    preview.asRole = raw.asRole as KnownRole;
  }
  return preview.level != null || preview.asRole != null ? preview : null;
}

export function FeatureExposureProvider({
  children,
  initialSettings = null,
}: {
  children: React.ReactNode;
  /** Settings read by the server layout in the same wave as the session (null ⇒ read here). */
  initialSettings?: FeatureExposureSettings | null;
}) {
  const { role } = useSession();
  const { t } = useAppPreferences();
  const [preview, setPreview] = useState<ExposurePreview | null>(null);
  // إعدادات النسبة من القاعدة (Phase 2). null أثناء التحميل ⇒ ثوابت Phase 1 (سلوك اليوم).
  const [dbSettings, setDbSettings] = useState<FeatureExposureSettings | null>(initialSettings);
  const hasInitialSettings = initialSettings != null;

  // جلب النسبة مرة عند التحميل — قراءة فاشلة-بأمان (أي خطأ ⇒ الافتراضي = سلوك اليوم).
  // الموظف يلتقط أي تغيير جديد عند تحديث/فتح الصفحة التالي (بدون realtime عمدًا).
  useEffect(() => {
    if (hasInitialSettings) return;
    let active = true;
    getFeatureExposureSettings().then((s) => {
      if (active) setDbSettings(s);
    });
    return () => { active = false; };
  }, [hasInitialSettings]);

  // قراءة معاملات المعاينة مرة عند التحميل: من الرابط أولًا ثم من sessionStorage.
  // ملاحظة: تغيير الرابط أثناء التنقّل العميل لا يعاد قراءته — يكفي تحديث الصفحة (بسيط عمدًا).
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const fromUrl = parsePreview({
        level: params.get("exposure") ?? undefined,
        asRole: params.get("asRole") ?? undefined,
      });
      if (fromUrl) {
        sessionStorage.setItem(PREVIEW_STORAGE_KEY, JSON.stringify(fromUrl));
        setPreview(fromUrl);
        return;
      }
      const stored = sessionStorage.getItem(PREVIEW_STORAGE_KEY);
      if (stored) setPreview(parsePreview(JSON.parse(stored)));
    } catch {
      // معاينة اختيارية — أي فشل قراءة يعني ببساطة: لا معاينة.
      setPreview(null);
    }
  }, []);

  const value = useMemo<FeatureExposureValue>(() => {
    // المعاينة لـ admin فقط — لأي دور آخر تُتجاهل كليًا.
    const activePreview = role === "admin" && EXPOSURE_ENABLED ? preview : null;
    const exposureRole: Role = activePreview?.asRole ?? role;
    const level: ExposureLevel = activePreview
      ? (activePreview.level ?? getExposureLevelForRole(exposureRole))
      : resolveEffectiveLevel(role, dbSettings);
    return {
      level,
      exposureRole,
      previewActive: activePreview != null,
      isVisible: (key, context) => isFeatureVisible(key, exposureRole, { level, context }),
      clearPreview: () => {
        try { sessionStorage.removeItem(PREVIEW_STORAGE_KEY); } catch { /* غير حرج */ }
        setPreview(null);
      },
    };
  }, [role, preview, dbSettings]);

  return (
    <FeatureExposureCtx.Provider value={value}>
      {children}
      {value.previewActive && (
        <div className="fixed bottom-3 start-3 z-50 flex items-center gap-2 rounded-full border border-warn/30 bg-warn-soft px-3 py-1.5 text-xs font-medium text-warn shadow-modal max-md:bottom-[80px]">
          <span>
            {t.featureExposure.previewBanner
              .replace("{level}", String(value.level))
              .replace("{role}", value.exposureRole ? (t.roles[value.exposureRole] ?? value.exposureRole) : "—")}
          </span>
          <button
            onClick={value.clearPreview}
            className="rounded-full bg-surface px-2 py-0.5 font-semibold text-fg transition hover:bg-sunk"
          >
            {t.featureExposure.previewExit}
          </button>
        </div>
      )}
    </FeatureExposureCtx.Provider>
  );
}

export function useFeatureExposure() {
  return useContext(FeatureExposureCtx);
}
