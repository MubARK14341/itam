"use client";

import { useEffect } from "react";
import { CheckCircle2, AlertCircle } from "lucide-react";
import { friendlyErrorStrict } from "@/lib/user-facing-errors";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";

export type ToastState = { message: string; type: "success" | "error" } | null;

export function Toast({ toast, onDone }: { toast: ToastState; onDone: () => void }) {
  const { lang } = useAppPreferences();
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(onDone, 3200);
    return () => clearTimeout(t);
  }, [toast, onDone]);

  if (!toast) return null;
  const ok = toast.type === "success";
  // شبكة أمان مركزية: رسائل الخطأ لا تعرض نص Supabase/Postgres الخام مطلقًا.
  const message = ok ? toast.message : friendlyErrorStrict(toast.message, lang);
  return (
    <div
      role={ok ? "status" : "alert"}
      aria-live={ok ? "polite" : "assertive"}
      aria-atomic="true"
      className="fixed inset-x-4 bottom-5 z-[60] mx-auto flex w-fit max-w-[calc(100vw-2rem)] animate-fade-in-up items-center gap-2.5 rounded-full bg-fg px-4 py-2.5 text-sm text-canvas shadow-modal max-md:bottom-24"
    >
      {ok
        ? <CheckCircle2 aria-hidden="true" className="h-[18px] w-[18px] shrink-0 text-emerald-300 dark:text-emerald-700" />
        : <AlertCircle aria-hidden="true" className="h-[18px] w-[18px] shrink-0 text-rose-300 dark:text-rose-700" />}
      <span className="font-medium">{message}</span>
    </div>
  );
}
