"use client";

import { AlertTriangle, RotateCw } from "lucide-react";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import type { DashboardSource, WidgetResult } from "@/lib/dashboard/dashboard-types";

function SourceList({ sources }: { sources: DashboardSource[] }) {
  const { t } = useAppPreferences();
  if (!sources.length) return null;
  return (
    <span>
      {t.dashboard.v6.states.unavailableSource}:{" "}
      {sources.map((source) => t.dashboard.v6.states.sources[source]).join(" · ")}
    </span>
  );
}

export function WidgetError({
  sources,
  onRetry,
}: {
  sources: DashboardSource[];
  onRetry: () => void;
}) {
  const { t } = useAppPreferences();
  return (
    <div role="alert" className="rounded-control bg-bad-soft p-4 text-sm text-bad">
      <div className="flex flex-wrap items-start gap-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">{t.dashboard.v6.states.errorTitle}</p>
          <p className="mt-1 text-xs leading-5 text-fg-2">{t.dashboard.v6.states.errorDescription}</p>
          <p className="mt-1 text-xs text-fg-2"><SourceList sources={sources} /></p>
        </div>
        <button
          type="button"
          onClick={onRetry}
          className="dashboard-interactive ui-button ui-button-outline ui-button-sm min-h-11 shrink-0"
        >
          <RotateCw className="h-4 w-4" aria-hidden="true" />
          {t.dashboard.v6.states.retry}
        </button>
      </div>
    </div>
  );
}

export function WidgetPartial<T>({ result, priority = false }: { result: WidgetResult<T>; priority?: boolean }) {
  const { t } = useAppPreferences();
  if (result.status === "error" || !result.isPartial) return null;
  const sources = result.unavailableSources ?? [];
  return (
    <div role="status" className="mb-3 rounded-control bg-warn-soft px-3 py-2 text-xs leading-5 text-warn">
      <p className="font-semibold">{t.dashboard.v6.states.partialTitle}</p>
      <p className="text-fg-2">{priority ? t.dashboard.v6.states.priorityPartial : t.dashboard.v6.states.partialDescription}</p>
      <p className="text-fg-2"><SourceList sources={sources} /></p>
    </div>
  );
}

export function WidgetEmpty({ priority = false }: { priority?: boolean }) {
  const { t } = useAppPreferences();
  return (
    <div className="rounded-control border border-dashed border-line-strong bg-surface-2 px-4 py-8 text-center text-[13px] text-muted">
      {priority ? t.dashboard.v6.states.emptyPriority : t.dashboard.v6.states.empty}
    </div>
  );
}
