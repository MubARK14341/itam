"use client";

import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { getAssetTemplate } from "@/lib/asset-type-templates";

interface AssetLike {
  name?: string | null;
  serial_number?: string | null;
  category?: { name?: string | null; name_ar?: string | null } | null;
  special_attributes?: unknown;
}

/** شارة صغيرة تعرض نوع القالب المكتشف للأصل (طبقة عرض فقط — لا تعدّل التصنيف). */
export function AssetTemplateBadge({ asset }: { asset: AssetLike }) {
  const { t } = useAppPreferences();
  const template = getAssetTemplate(asset);
  return (
    <span
      className="inline-flex h-[22px] items-center rounded-md border border-line bg-surface-2 px-2 text-[11.5px] font-medium text-fg-2"
    >
      {t.assetTemplates[template.id].label}
    </span>
  );
}
