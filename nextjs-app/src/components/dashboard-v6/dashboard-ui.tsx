"use client";

import React, { type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import type { DashboardSeverity } from "@/lib/dashboard/dashboard-types";
import type { Tone } from "@/lib/tone";
import { StatusChip } from "@/components/ui/status-chip";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";

export const DASHBOARD_SURFACE = "ui-surface";
export const DASHBOARD_META = "text-[13px] leading-5 text-muted";
export const DASHBOARD_TITLE = "font-display text-[15px] font-semibold text-fg";
export const DASHBOARD_LINK = "inline-flex min-h-11 items-center justify-center gap-1 rounded-lg text-[13px] font-semibold text-brand-ink underline-offset-4 hover:underline";

/**
 * Studio section: one card with a heading row. `plain` keeps the heading but lets the
 * children supply their own cards (used by the chart pair).
 */
export function DashboardSection({
  id,
  title,
  description,
  icon: Icon,
  action,
  children,
  className = "",
  bodyClassName = "px-5 pb-5",
  plain = false,
}: {
  id: string;
  title: string;
  description: string;
  icon?: LucideIcon;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  plain?: boolean;
}) {
  return (
    <section aria-labelledby={id} className={`${plain ? "min-w-0" : `${DASHBOARD_SURFACE} overflow-hidden`} break-inside-avoid ${className}`}>
      <div className={`flex min-w-0 flex-wrap items-start justify-between gap-3 ${plain ? "mb-4" : "px-5 pb-4 pt-5 sm:px-6"}`}>
        <div className="min-w-0">
          <h2 id={id} className="flex items-center gap-2 font-display text-[18px] font-semibold text-fg">
            {Icon && <Icon className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />}
            {title}
          </h2>
          <p className={`mt-0.5 max-w-3xl ${DASHBOARD_META}`}>{description}</p>
        </div>
        {action}
      </div>
      {plain ? children : <div className={bodyClassName}>{children}</div>}
    </section>
  );
}

export const SEVERITY_TONE: Record<DashboardSeverity, Tone> = {
  neutral: "neu",
  info: "info",
  success: "ok",
  warning: "warn",
  critical: "bad",
};

/** Numbers coloured by severity (always paired with a text label or chip, never colour alone). */
export const SEVERITY_VALUE_TEXT: Record<DashboardSeverity, string> = {
  neutral: "text-fg",
  info: "text-fg",
  success: "text-fg",
  warning: "text-warn",
  critical: "text-bad",
};

export function SeverityBadge({ severity, size = "md" }: { severity: DashboardSeverity; size?: "sm" | "md" }) {
  const { t } = useAppPreferences();
  return (
    <StatusChip tone={SEVERITY_TONE[severity]} size={size}>
      {t.dashboard.v6.priority.severity[severity]}
    </StatusChip>
  );
}

export function LtrText({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <bdi dir="ltr" className={`[unicode-bidi:isolate] tabular-nums ${className}`}>{children}</bdi>;
}
