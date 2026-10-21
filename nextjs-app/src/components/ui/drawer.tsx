"use client";

import { useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { useModalFocus } from "@/components/ui/dialog";

/** Side panel anchored to the inline-end edge (bottom sheet on phones). Same a11y contract as Dialog. */
export function Drawer({
  open, onClose, title, eyebrow, children, footer, closeLabel, width = "md",
}: {
  open: boolean; onClose: () => void; title: ReactNode; eyebrow?: ReactNode;
  children: ReactNode; footer?: ReactNode; closeLabel?: string; width?: "md" | "lg";
}) {
  const { t } = useAppPreferences();
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  useModalFocus(open, onClose, panelRef);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end sm:items-stretch sm:justify-end">
      <div className="absolute inset-0 animate-fade-in bg-[rgb(var(--scrim)/0.34)] dark:bg-black/60" onClick={onClose} aria-hidden="true" />
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
        className={`relative z-10 flex max-h-[92dvh] w-full animate-sheet-in flex-col overflow-hidden rounded-t-2xl border-line bg-surface shadow-modal sm:max-h-none sm:rounded-none sm:border-s ${width === "lg" ? "sm:max-w-2xl" : "sm:max-w-[460px]"}`}>
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0">
            {eyebrow && <div className="mb-1 text-[13px] text-muted">{eyebrow}</div>}
            <h2 id={titleId} className="font-display text-lg font-semibold text-fg">{title}</h2>
          </div>
          <button type="button" onClick={onClose} aria-label={closeLabel ?? t.common.close} className="-me-1.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-sunk hover:text-fg max-md:h-11 max-md:w-11">
            <X aria-hidden="true" className="h-5 w-5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-5 py-5">{children}</div>
        {footer && <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-line bg-surface-2 px-5 py-3.5">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
