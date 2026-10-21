"use client";

import { AlertTriangle, PackageOpen, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { interpolate } from "@/lib/i18n";
import { formatDate } from "@/lib/format";
import { AssetTemplateBadge } from "@/components/assets/asset-template-badge";
import {
  getAssetTemplate,
  TEMPLATES,
  IMPORTANT_FIELDS,
  IMPORT_META_KEYS,
  type TemplateField,
} from "@/lib/asset-type-templates";
import { computeCompleteness, hasValue } from "@/lib/asset-completeness";

// مفاتيح الحقول المالية عبر كل القوالب (monthlyCost / unitCost) — لا تُعرض في «حقول أخرى» لغير المخوّل ماليًا
const FINANCIAL_ATTR_KEYS = new Set(
  Object.values(TEMPLATES).flatMap((tpl) => tpl.fields.filter((f) => f.financial).map((f) => f.key)),
);

interface AssetLike {
  name?: string | null;
  serial_number?: string | null;
  category?: { name?: string | null; name_ar?: string | null } | null;
  special_attributes?: Record<string, unknown> | null;
}

/**
 * قسم «تفاصيل إضافية حسب نوع الأصل» (قراءة فقط) لصفحة تفاصيل الأصل.
 * يعرض النوع المكتشف + تنبيهات + مؤشّر اكتمال البيانات + الحقول المهمة للقالب الحالي
 * (حتى الفارغة تظهر كـ «غير مدخل») مع احترام الصلاحيات المالية/الحساسة، ثم المفاتيح
 * القديمة الأخرى، وأخيرًا بيانات الاستيراد التقنية داخل أكورديون للمخوّلين فقط.
 * طبقة عرض بحتة — لا تعديل بيانات / قاعدة / RLS.
 */
export function AssetExtraDetails({
  asset,
  canSeeFinancial,
  canWrite,
  onEdit,
}: {
  asset: AssetLike;
  canSeeFinancial: boolean;
  canWrite: boolean;
  /** فتح نافذة تعديل الأصل لاستكمال الحقول الناقصة (يظهر الزر فقط عند canWrite). */
  onEdit?: () => void;
}) {
  const { t, lang } = useAppPreferences();
  const ui = t.assetTemplates.ui;
  const warn = t.assetTemplateWarnings;
  const fieldLabels = t.assetTemplateFields as Record<string, string>;
  const optionLabels = t.assetTemplateOptions as Record<string, string>;

  const template = getAssetTemplate(asset);
  const attrs = asset.special_attributes ?? {};
  const templateKeys = new Set(template.fields.map((f) => f.key));
  const importantKeys = IMPORTANT_FIELDS[template.id];

  // يمرّ الحقل للعرض إن سُمح به للدور الحالي (مالي/حساس) ولم يُستثنَ من التفاصيل.
  const isVisible = (f: TemplateField) =>
    f.visibleInDetails !== false && (!f.financial || canSeeFinancial) && (!f.sensitive || canWrite);

  // اكتمال البيانات — مصدر حساب واحد مشترك مع جدول الأصول (asset-completeness).
  const { filled: filledCount, total: totalCount, pct, needsCompletion, tier } = computeCompleteness(asset, {
    canSeeFinancial,
    canWrite,
  });

  // الحقول المعروضة: المهمة دائمًا (حتى الفارغة) + أي حقل آخر للقالب يحمل قيمة فعلية.
  const shownFields = template.fields.filter(
    (f) => isVisible(f) && (importantKeys.has(f.key) || hasValue(attrs[f.key])),
  );

  // مفاتيح أخرى قديمة/مجهولة لا يملكها القالب — تُعرض كما هي (باستثناء بيانات الاستيراد، والمالية لغير المخوّل).
  const otherEntries = Object.entries(attrs).filter(
    ([k, v]) =>
      !templateKeys.has(k) &&
      !IMPORT_META_KEYS.has(k) &&
      hasValue(v) &&
      (canSeeFinancial || !FINANCIAL_ATTR_KEYS.has(k)),
  );

  // بيانات الاستيراد التقنية — للمخوّلين ماليًا (admin / it_manager) فقط، داخل أكورديون.
  const importMetaEntries = canSeeFinancial
    ? Object.entries(attrs).filter(([k, v]) => IMPORT_META_KEYS.has(k) && hasValue(v))
    : [];

  const renderField = (f: TemplateField): { text: string; empty: boolean } => {
    const raw = attrs[f.key];
    if (!hasValue(raw)) return { text: ui.notProvided, empty: true };
    if (f.type === "boolean") return { text: raw === true || raw === "true" ? ui.yes : ui.no, empty: false };
    if (f.type === "select") return { text: optionLabels[String(raw)] ?? String(raw), empty: false };
    if (f.type === "date") return { text: formatDate(String(raw), lang), empty: false };
    return { text: String(raw), empty: false };
  };

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-display text-[15px] font-semibold text-fg">{ui.sectionTitle}</h3>
        <span className="inline-flex items-center gap-1.5 text-xs text-muted">
          {ui.detectedType}: <AssetTemplateBadge asset={asset} />
        </span>
      </div>

      {template.needsReview && (
        <div role="note" className="mb-3 flex items-start gap-2.5 rounded-xl bg-warn-soft px-3 py-2.5 text-[12.5px] leading-relaxed text-warn">
          <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <span><strong className="font-semibold">{warn.needsClassification}</strong> — {warn.needsClassificationDesc}</span>
        </div>
      )}
      {template.consumableLike && (
        <div role="note" className="mb-3 flex items-start gap-2.5 rounded-xl bg-warn-soft px-3 py-2.5 text-[12.5px] leading-relaxed text-warn">
          <PackageOpen aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <span><strong className="font-semibold">{warn.consumableLike}</strong> — {warn.consumableLikeDesc}</span>
        </div>
      )}

      {/* اكتمال بيانات النوع */}
      {totalCount > 0 && (
        <div className="mb-4 rounded-xl border border-line bg-surface-2 px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[12.5px] font-semibold text-fg-2">{ui.typeDataCompleteness}</span>
            <span className="text-xs tabular-nums text-muted" dir="ltr">
              {interpolate(ui.completenessSummary, { filled: filledCount, total: totalCount })} · {pct}%
            </span>
          </div>
          <span
            role="progressbar"
            aria-label={ui.typeDataCompleteness}
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            className="mt-2 block h-1.5 w-full overflow-hidden rounded-full bg-sunk"
          >
            <span className={`block h-full rounded-full transition-all ${tier === "high" ? "bg-ok" : tier === "mid" ? "bg-warn" : "bg-bad"}`} style={{ width: `${pct}%` }} />
          </span>
          {needsCompletion && (
            <div className="mt-2 flex items-start gap-1.5 text-xs text-warn">
              <AlertTriangle aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{ui.needsTypeDataCompletion}</span>
            </div>
          )}
          {canWrite && onEdit && (
            <Button size="sm" variant="outline" className="mt-3" onClick={onEdit}>
              <Pencil aria-hidden="true" className="h-3.5 w-3.5" />
              {ui.completeAssetDetails}
            </Button>
          )}
        </div>
      )}

      {shownFields.length > 0 ? (
        <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2 xl:grid-cols-3">
          {shownFields.map((f) => {
            const { text, empty } = renderField(f);
            return (
              <div key={f.key} className="flex min-w-0 flex-col">
                <dt className="text-xs text-muted">{fieldLabels[f.key] ?? f.key}</dt>
                <dd
                  dir={f.ltr && !empty ? "ltr" : undefined}
                  className={
                    empty
                      ? "mt-1 text-[13.5px] text-muted"
                      : "mt-1 break-words text-[13.5px] font-medium text-fg [unicode-bidi:isolate]"
                  }
                >
                  {text}
                </dd>
              </div>
            );
          })}
        </dl>
      ) : (
        !template.needsReview && !template.consumableLike && (
          <p className="text-[13px] text-muted">{ui.noExtra}</p>
        )
      )}

      {otherEntries.length > 0 && (
        <div className="mt-4 border-t border-line pt-3">
          <p className="mb-2 text-[12.5px] font-semibold text-fg-2">{ui.otherFieldsTitle}</p>
          <div className="grid grid-cols-1 gap-2 text-[13px] sm:grid-cols-2">
            {otherEntries.map(([k, v]) => (
              <div key={k}>
                <span className="text-muted" dir="ltr">{k}: </span>
                <span className="tag text-fg-2">{String(v)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {importMetaEntries.length > 0 && (
        <details className="mt-4 border-t border-line pt-3">
          <summary className="cursor-pointer select-none text-[12.5px] font-semibold text-fg-2 hover:text-fg">
            {ui.importMetadata}
          </summary>
          <div className="mt-2 grid grid-cols-1 gap-2 text-[13px] sm:grid-cols-2">
            {importMetaEntries.map(([k, v]) => (
              <div key={k}>
                <span className="text-muted" dir="ltr">{k}: </span>
                <span className="tag text-fg-2">{String(v)}</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
