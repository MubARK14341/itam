"use client";

import { useEffect } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { Button } from "@/components/ui/button";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const { lang } = useAppPreferences();

  useEffect(() => {
    console.error("App route failed", { digest: error.digest ?? "unavailable" });
  }, [error]);

  const isArabic = lang === "ar";

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-4 sm:p-6">
      <section
        role="alert"
        className="ui-surface flex w-full max-w-lg flex-col items-center px-6 py-10 text-center sm:px-8"
      >
        <span className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-bad-soft text-bad">
          <AlertTriangle aria-hidden="true" className="h-6 w-6" />
        </span>
        <h1 className="mt-4 font-display text-xl font-semibold text-fg">
          {isArabic ? "تعذّر تحميل هذه الصفحة" : "This page could not be loaded"}
        </h1>
        <p className="mt-2 max-w-sm text-sm text-muted">
          {isArabic
            ? "حدث خطأ غير متوقع. لم نعرض أي تفاصيل تقنية قد تحتوي على بيانات حساسة."
            : "An unexpected error occurred. Technical details that may contain sensitive data are hidden."}
        </p>
        <Button type="button" onClick={reset} className="mt-6">
          <RotateCcw aria-hidden="true" />
          {isArabic ? "إعادة المحاولة" : "Try again"}
        </Button>
      </section>
    </div>
  );
}
