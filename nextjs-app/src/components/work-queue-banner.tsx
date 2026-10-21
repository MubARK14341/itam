"use client";

// شعار «قائمة العمل» — يظهر أعلى الجدول عند فتح قائمة مفلترة من تنبيه (?view=).
// العدد هنا يُحسب بنفس شرط الكرت (المصدر الموحد alert-predicates.ts) فيطابقه دائمًا.
// لا يعرض أي بيانات مالية؛ زر CSV اختياري ومسؤولية أعمدته على المستدعي.

import { ClipboardCheck, X, Download } from "lucide-react";
import { buttonClass } from "@/components/ui/button";

export function WorkQueueBanner({
  title, desc, action, count, clearLabel, csvLabel, onClear, onCsv, csvBusy = false, extra,
}: {
  title: string;
  desc: string;
  action: string;
  count: number;
  clearLabel: string;
  csvLabel?: string;
  onClear: () => void;
  onCsv?: () => void;
  csvBusy?: boolean;
  // زر/أزرار إضافية خاصة بالقائمة (مثل «تجهيز طلب شراء» في نواقص المستهلكات)
  extra?: React.ReactNode;
}) {
  return (
    <div className="ui-surface mb-4 px-4 py-3.5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[11px] bg-brand-soft text-brand-ink">
            <ClipboardCheck aria-hidden="true" className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-fg">
              {title}
              <span className="ui-count ui-count-hot" dir="ltr">{count}</span>
            </p>
            <p className="mt-0.5 text-[13px] text-muted">{desc}</p>
            <p className="mt-1 text-[13px] font-medium text-brand-ink">{action}</p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
          {extra}
          {onCsv && csvLabel && (
            <button type="button" onClick={onCsv} disabled={csvBusy} aria-busy={csvBusy} className={buttonClass("outline", "sm")}>
              <Download aria-hidden="true" className="h-3.5 w-3.5" />{csvLabel}
            </button>
          )}
          <button type="button" onClick={onClear} className={buttonClass("ghost", "sm")}>
            <X aria-hidden="true" className="h-3.5 w-3.5" />{clearLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
