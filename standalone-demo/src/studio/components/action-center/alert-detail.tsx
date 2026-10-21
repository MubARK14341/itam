"use client";

import Link from "next/link";
import { BellRing, CheckCircle2, ExternalLink, Play, StickyNote, UserPlus } from "lucide-react";
import { Button, buttonClass } from "@/components/ui/button";
import { StatusChip } from "@/components/ui/status-chip";
import { EmptyState } from "@/components/ui/empty-state";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { formatDateTime } from "@/lib/format";
import type { Tone } from "@/lib/tone";
import {
  actionAlertUrl, type ActionAlertInstance, type ActionAlertSeverity, type ActionAlertStatus,
} from "@/lib/action-center";

export const ALERT_SEVERITY_TONE: Record<ActionAlertSeverity, Tone> = {
  critical: "bad",
  high: "warn",
  medium: "info",
  low: "neu",
};

export const ALERT_STATUS_TONE: Record<ActionAlertStatus, Tone> = {
  open: "warn",
  reopened: "bad",
  in_progress: "info",
  auto_resolved: "ok",
};

/** Placeholder for the lg detail column when nothing is selected. */
export function AlertDetailEmpty() {
  const { t } = useAppPreferences();
  const ta = t.actionCenter;
  return <EmptyState icon={BellRing} title={ta.noSelectionTitle} description={ta.noSelectionDesc} />;
}

/**
 * Detail body for one alert. Actions are the same page callbacks the list used before
 * (act now link, start, assign / assign to me, note) with the same role/status conditions.
 */
export function AlertDetail({
  alert, assigneeLabel, write, isManager, me, showTitle = true,
  onStart, onAssign, onAssignToMe, onNote,
}: {
  alert: ActionAlertInstance;
  assigneeLabel: string | null;
  write: boolean;
  isManager: boolean;
  me: string | null;
  showTitle?: boolean;
  onStart: () => void;
  onAssign: () => void;
  onAssignToMe: () => void;
  onNote: () => void;
}) {
  const { t, lang } = useAppPreferences();
  const ta = t.actionCenter;
  const r = alert;
  const resolved = r.status === "auto_resolved";
  const canStart = write && (r.status === "open" || r.status === "reopened");

  const facts: { label: string; value: React.ReactNode }[] = [
    { label: ta.firstSeen, value: <bdi dir="ltr" className="tabular-nums">{formatDateTime(r.first_seen_at, lang)}</bdi> },
    { label: ta.lastSeen, value: <bdi dir="ltr" className="tabular-nums">{formatDateTime(r.last_seen_at, lang)}</bdi> },
    ...(r.metadata?.due_at ? [{ label: ta.due, value: <bdi dir="ltr" className="tabular-nums">{formatDateTime(r.metadata.due_at, lang)}</bdi> }] : []),
    { label: ta.assignee, value: r.assigned_to ? (assigneeLabel ?? "—") : <span className="text-muted">{ta.unassigned}</span> },
    { label: ta.occurrences, value: <span className="tabular-nums" dir="ltr">{r.occurrence_count}</span> },
    ...(r.last_action_at ? [{ label: ta.lastAction, value: <bdi dir="ltr" className="tabular-nums">{formatDateTime(r.last_action_at, lang)}</bdi> }] : []),
  ];

  return (
    <div className="flex min-w-0 flex-col">
      <div className={showTitle ? "px-5 pb-4 pt-6" : "pb-4"}>
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip tone={ALERT_SEVERITY_TONE[r.severity]}>{ta.sev[r.severity]}</StatusChip>
          <StatusChip tone={ALERT_STATUS_TONE[r.status]}>{ta.statuses[r.status]}</StatusChip>
        </div>
        {showTitle && (
          <h2 className="mt-3 font-display text-[19px] font-semibold leading-snug text-fg">{ta.types[r.alert_type] ?? r.alert_type}</h2>
        )}
        {(r.metadata?.label || r.metadata?.count != null) && (
          <p className="mt-1 flex flex-wrap items-center gap-2 text-[13.5px] text-fg-2">
            {r.metadata?.label && <span className="tag font-medium text-brand-ink" dir="ltr">{r.metadata.label}</span>}
            {r.metadata?.count != null && <span className="ui-count" dir="ltr">{r.metadata.count}</span>}
          </p>
        )}
      </div>

      <div className={`order-3 flex flex-col gap-4 ${showTitle ? "px-5 py-5" : "border-y border-line py-4"}`}>
        {resolved ? (
          <div className="flex gap-2.5 rounded-control bg-ok-soft px-3 py-2.5 text-[13px] leading-6 text-ok">
            <CheckCircle2 aria-hidden="true" className="mt-1 h-4 w-4 shrink-0" />
            <span>
              <b className="font-semibold">{ta.resolvedAt}</b>
              {r.auto_resolved_at && <> · <bdi dir="ltr" className="tabular-nums">{formatDateTime(r.auto_resolved_at, lang)}</bdi></>}
            </span>
          </div>
        ) : (
          <>
            <Link href={actionAlertUrl(r)} className={buttonClass("primary", "md", "w-full")}>
              <ExternalLink aria-hidden="true" className="h-4 w-4" />{ta.actNow}
            </Link>
            {write && (
              <div>
                <p className="ui-label">{ta.handling}</p>
                <div className="flex flex-wrap gap-2">
                  {canStart && (
                    <Button size="sm" variant="outline" onClick={onStart}>
                      <Play aria-hidden="true" className="h-3.5 w-3.5" />{ta.start}
                    </Button>
                  )}
                  {isManager ? (
                    <Button size="sm" variant="outline" onClick={onAssign}>
                      <UserPlus aria-hidden="true" className="h-3.5 w-3.5" />{ta.assign}
                    </Button>
                  ) : r.assigned_to !== me ? (
                    <Button size="sm" variant="outline" onClick={onAssignToMe}>
                      <UserPlus aria-hidden="true" className="h-3.5 w-3.5" />{ta.assignToMe}
                    </Button>
                  ) : null}
                  <Button size="sm" variant="ghost" onClick={onNote}>
                    <StickyNote aria-hidden="true" className="h-3.5 w-3.5" />{ta.note}
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <dl className={`order-2 grid grid-cols-2 gap-4 text-[13px] ${showTitle ? "px-5 py-4" : "py-4"}`}>
        {facts.map((fact) => (
          <div key={fact.label} className="min-w-0 border-b border-line pb-3">
            <dt className="mb-2 text-xs text-muted">{fact.label}</dt>
            <dd className="min-w-0 break-words font-medium text-fg">{fact.value}</dd>
          </div>
        ))}
      </dl>
      {write && !resolved && (
        <p className={`order-4 text-xs leading-5 text-muted ${showTitle ? "border-t border-line bg-surface-2 px-5 py-4" : "border-t border-line pt-3"}`}>{ta.noteHint}</p>
      )}
    </div>
  );
}
