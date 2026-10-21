"use client";

// بوابات الإظهار التدريجي:
// - FeatureGate: إظهار/إخفاء عنصر داخلي (زر/بطاقة/تبويب) حسب مستوى العرض.
// - FeatureRoute: حماية صفحة كاملة فُتحت برابط مباشر — تعرض لوحة ودّية
//   «تُفعَّل لاحقًا» (ليست رسالة صلاحيات! الصلاحيات شأن RBAC/RLS وحدها).
// admin لا يُحجب أبدًا (isFeatureVisible ترجع true له دائمًا خارج المعاينة).

import Link from "next/link";
import { Hourglass } from "lucide-react";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { useFeatureExposure } from "@/components/providers/feature-exposure-provider";
import type { FeatureKey, FeatureVisibilityContext } from "@/lib/feature-exposure";

export function FeatureGate({
  feature,
  context,
  children,
  fallback = null,
}: {
  feature: FeatureKey;
  context?: FeatureVisibilityContext;
  children: React.ReactNode;
  fallback?: React.ReactNode;
}) {
  const { isVisible } = useFeatureExposure();
  return isVisible(feature, context) ? <>{children}</> : <>{fallback}</>;
}

export function FeatureUnavailablePanel() {
  const { t } = useAppPreferences();
  return (
    <div className="mx-auto mt-16 max-w-md rounded-card border border-line bg-surface p-8 text-center">
      <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-sunk text-muted">
        <Hourglass aria-hidden="true" className="h-6 w-6" />
      </div>
      {/* يحلّ محل الصفحة كاملة (FeatureRoute / صفحات مغلقة) — فهو عنوان الصفحة الرئيسي. */}
      <h1 className="font-display text-lg font-semibold text-fg">
        {t.featureExposure.title}
      </h1>
      <p className="mt-2 text-sm text-muted">
        {t.featureExposure.desc}
      </p>
      <Link
        href="/dashboard"
        className="ui-button ui-button-primary ui-button-md mt-6"
      >
        {t.featureExposure.backToDashboard}
      </Link>
    </div>
  );
}

export function FeatureRoute({
  feature,
  children,
}: {
  feature: FeatureKey;
  children: React.ReactNode;
}) {
  const { isVisible } = useFeatureExposure();
  if (!isVisible(feature)) return <FeatureUnavailablePanel />;
  return <>{children}</>;
}
