"use client";

import type { ReactNode } from "react";
import { handleTabKeyDown } from "@/components/ui/tab-keyboard";

export type TabItem<K extends string> = { key: K; label: ReactNode; count?: number; icon?: ReactNode };

/**
 * ARIA tabs in the Ledger styles: "underline" for page sections, "segmented" for 2–4 views.
 * Panels are rendered by the caller with role="tabpanel" + aria-labelledby={tabId(idBase, key)}.
 */
export function Tabs<K extends string>({
  items, value, onChange, label, idBase, variant = "underline", className = "",
}: {
  items: TabItem<K>[]; value: K; onChange: (key: K) => void; label: string; idBase: string;
  variant?: "underline" | "segmented"; className?: string;
}) {
  const seg = variant === "segmented";
  return (
    <div role="tablist" aria-label={label} className={`${seg ? "ui-seg" : "ui-tabs"} ${className}`}>
      {items.map((item) => {
        const selected = item.key === value;
        return (
          <button
            key={item.key}
            type="button"
            role="tab"
            id={tabId(idBase, item.key)}
            aria-selected={selected}
            aria-controls={panelId(idBase, item.key)}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(item.key)}
            onKeyDown={handleTabKeyDown}
            className={seg ? "ui-seg-item" : "ui-tab"}
          >
            {item.icon}
            {item.label}
            {item.count !== undefined && (
              <span className={seg ? "text-[11.5px] tabular-nums text-muted" : "ui-count"}>{item.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export const tabId = (idBase: string, key: string) => `${idBase}-tab-${key}`;
export const panelId = (idBase: string, key: string) => `${idBase}-panel-${key}`;
