"use client";

import { useEffect, useId, useLayoutEffect, useRef, type RefObject } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";

const SIZE: Record<string, string> = {
  lg: "max-w-lg", xl: "max-w-xl", "2xl": "max-w-2xl", "3xl": "max-w-3xl", "4xl": "max-w-4xl", "5xl": "max-w-5xl",
};

/** Focus trap + Escape + body scroll lock + focus restore, shared by Dialog and Drawer. */
export function useModalFocus(open: boolean, onClose: () => void, containerRef: RefObject<HTMLElement | null>) {
  const lastFocusedRef = useRef<HTMLElement | null>(null);
  // onClose عبر ref: الصفحات تمرّر غالبًا دالة inline — إعادة تشغيل الأثر مع كل render كانت تنقل التركيز خارج الحقل أثناء الكتابة.
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  // useLayoutEffect: Escape/Tab يُسجَّلان قبل رسم النافذة — لا توجد لحظة تظهر فيها بلا إغلاق بالكيبورد.
  useLayoutEffect(() => {
    if (!open) return;
    lastFocusedRef.current = document.activeElement as HTMLElement | null;
    const container = containerRef.current;
    const focusable = () => Array.from(container?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ) ?? []).filter((el) => !el.hasAttribute("hidden"));
    const initial = focusable()[0] ?? container;
    requestAnimationFrame(() => initial?.focus());

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.preventDefault(); onCloseRef.current(); return; }
      if (e.key !== "Tab") return;
      const nodes = focusable();
      if (nodes.length === 0) { e.preventDefault(); container?.focus(); return; }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      lastFocusedRef.current?.focus();
    };
  }, [open, containerRef]);
}

export function Dialog({
  open, onClose, title, children, footer, size = "lg", closeLabel, description,
}: {
  open: boolean; onClose: () => void; title: string;
  children: React.ReactNode; footer?: React.ReactNode;
  size?: "lg" | "xl" | "2xl" | "3xl" | "4xl" | "5xl";
  closeLabel?: string;
  description?: React.ReactNode;
}) {
  const { t } = useAppPreferences();
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocus(open, onClose, dialogRef);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
      <div className="absolute inset-0 animate-fade-in bg-[rgb(var(--scrim)/0.34)] dark:bg-black/60" onClick={onClose} aria-hidden="true" />
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
        className={`relative z-10 flex max-h-[calc(100dvh-1rem)] w-full flex-col ${SIZE[size] ?? SIZE.lg} animate-sheet-in overflow-hidden rounded-t-2xl border border-line bg-surface shadow-modal sm:max-h-[calc(100dvh-2rem)] sm:animate-scale-in sm:rounded-2xl`}>
        <div className="flex shrink-0 items-start justify-between gap-3 px-5 pb-3 pt-5">
          <div className="min-w-0">
            <h3 id={titleId} className="font-display text-[17px] font-semibold text-fg">{title}</h3>
            {description && <p className="mt-1 text-[13px] text-muted">{description}</p>}
          </div>
          <button type="button" onClick={onClose} aria-label={closeLabel ?? t.common.close} className="-me-1.5 -mt-1 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-sunk hover:text-fg max-md:h-11 max-md:w-11">
            <X aria-hidden="true" className="h-5 w-5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-5 pb-5 pt-1">{children}</div>
        {footer && <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-line bg-surface-2 px-5 py-3.5">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
