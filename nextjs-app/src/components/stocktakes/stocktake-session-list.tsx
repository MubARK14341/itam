"use client";

import { useMemo, useState } from "react";
import { ChevronLeft, ClipboardList } from "lucide-react";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusChip } from "@/components/ui/status-chip";
import type { StocktakeSession } from "@/lib/stocktakes";
import type { Dict } from "@/lib/i18n";
import { stocktakeProgress, stocktakeSessionTone } from "./stocktake-tones";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";

type ListFilter = "all" | "active" | "done";
const isActive = (s: StocktakeSession) => s.status === "draft" || s.status === "in_progress";

/** Session register with the existing local status filters and selection callback. */
export function StocktakeSessionList({
  sessions, selectedId, onSelect, stateLabel, t, dash,
}: {
  sessions: StocktakeSession[];
  selectedId: string | null;
  onSelect: (session: StocktakeSession) => void;
  stateLabel: (value: string) => string;
  t: Dict["stocktakes"];
  dash: string;
}) {
  const { t: copy } = useAppPreferences();
  const [filter, setFilter] = useState<ListFilter>("all");
  const counts = useMemo(() => ({
    all: sessions.length,
    active: sessions.filter(isActive).length,
    done: sessions.filter((s) => !isActive(s)).length,
  }), [sessions]);
  const shown = useMemo(() => sessions.filter((s) =>
    filter === "all" ? true : filter === "active" ? isActive(s) : !isActive(s)), [sessions, filter]);
  const FILTERS: Array<{ key: ListFilter; label: string }> = [
    { key: "all", label: t.filterAll },
    { key: "active", label: t.filterActive },
    { key: "done", label: t.filterDone },
  ];

  return (
    <Card className="flex h-fit flex-col overflow-hidden">
      <section aria-labelledby="stocktake-sessions-title">
        <div className="flex flex-wrap items-center justify-between gap-4 px-5 pt-6 sm:px-6">
          <h2 id="stocktake-sessions-title" className="font-display text-[17px] font-semibold text-fg">{t.sessions}</h2>
          <div role="group" aria-label={t.filterSessionsLabel} className="flex max-w-full items-center gap-5 overflow-x-auto">
            {FILTERS.map((f) => (
              <button key={f.key} type="button" aria-pressed={filter === f.key} onClick={() => setFilter(f.key)} className={`inline-flex min-h-12 shrink-0 items-center gap-2 border-b-[3px] text-[13px] ${filter === f.key ? "border-brand font-semibold text-fg" : "border-transparent text-muted hover:text-fg"}`}>
                {f.label}<span className="text-[11.5px] tabular-nums text-muted">{counts[f.key]}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="overflow-x-auto px-5 pb-5 pt-5 sm:px-6 sm:pb-6" tabIndex={0}>
          {sessions.length === 0 ? (
            <EmptyState icon={ClipboardList} title={t.empty} compact />
          ) : shown.length === 0 ? (
            <p className="px-5 py-8 text-center text-[13.5px] text-muted">{t.noSessionsForFilter}</p>
          ) : (
            <table className="ui-table min-w-[640px]">
              <caption className="sr-only">{t.sessions}</caption>
              <thead>
                <tr>
                  <th scope="col">{copy.requests.number}</th>
                  <th scope="col">{t.sessionTitle}</th>
                  <th scope="col">{copy.requests.status}</th>
                  <th scope="col">{t.progress}</th>
                  <th scope="col"><span className="sr-only">{copy.activity.viewDetails}</span></th>
                </tr>
              </thead>
              <tbody>
              {shown.map((session) => {
                const pct = stocktakeProgress(session);
                const current = selectedId === session.id;
                return (
                  <tr key={session.id} className={current ? "bg-brand-soft" : ""}>
                    <td><bdi dir="ltr" className="font-mono text-xs text-fg">{session.code}</bdi></td>
                    <td>
                      <span className="block text-sm font-medium text-fg">{session.title}</span>
                      <span className="mt-1 block text-xs text-muted">
                        {session.location_name ?? dash}{session.scope_label ? ` · ${session.scope_label}` : ""}
                      </span>
                    </td>
                    <td><StatusChip tone={stocktakeSessionTone(session)} size="sm">{stateLabel(session.review_state)}</StatusChip></td>
                    <td className="min-w-[10rem]">
                      <span aria-hidden="true" className="block h-[5px] overflow-hidden rounded-full bg-sunk">
                        <span className={`block h-full rounded-full ${session.status === "completed" ? "bg-ok" : "bg-brand"}`} style={{ width: `${pct}%` }} />
                      </span>
                      <span className="mt-1.5 flex items-center justify-between text-xs text-muted">
                        <span className="tabular-nums">{session.observed_count}/{session.expected_count}</span>
                        <span className="font-semibold tabular-nums text-fg-2">{pct}%</span>
                      </span>
                    </td>
                    <td>
                      <button type="button" aria-current={current ? "true" : undefined} onClick={() => onSelect(session)} className="inline-flex min-h-11 items-center gap-2 whitespace-nowrap rounded-control px-2 text-xs font-medium text-muted hover:bg-surface-2 hover:text-fg">
                        {copy.activity.viewDetails}<ChevronLeft aria-hidden="true" className="h-4 w-4 ltr:rotate-180" />
                      </button>
                    </td>
                  </tr>
                );
              })}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </Card>
  );
}
