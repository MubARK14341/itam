"use client";

import { useMemo } from "react";
import Link from "next/link";
import type { RequestListRow } from "@/lib/requests";
import { isOverdue } from "@/lib/requests";
import { simplifiedRequestStatus, type DisplayRequestStatus } from "@/lib/request-fulfillment";
import { buildRequestQueuePath, withRequestQueueContext, type RequestQueueState } from "@/lib/request-navigation";
import { formatDate } from "@/lib/format";
import type { Tone } from "@/lib/tone";
import { StatusChip } from "@/components/ui/status-chip";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { PartyTag, RequestNumber, ResponsibleCell, TONE_DOT, type RequestParty } from "@/components/requests/request-list-bits";

// لوحة المراحل: عرض فقط — تجميع الصفوف المحمّلة حاليًا بحسب الحالة المبسّطة (بلا سحب وإفلات ولا أي تعديل).
type ColumnKey = DisplayRequestStatus | "closed";

const OPEN_COLUMNS: DisplayRequestStatus[] = [
  "under_review", "needs_clarification", "preparing", "awaiting_supply", "ready_for_pickup", "delivered", "returned",
];
const CLOSED: DisplayRequestStatus[] = ["completed", "rejected", "cancelled"];

const COLUMN_TONE: Record<ColumnKey, Tone> = {
  draft: "neu",
  under_review: "info",
  needs_clarification: "warn",
  preparing: "res",
  awaiting_supply: "warn",
  ready_for_pickup: "ok",
  delivered: "neu",
  returned: "ok",
  completed: "ok",
  rejected: "neu",
  cancelled: "neu",
  closed: "neu",
};

export function RequestsBoard({
  rows, queueState, custName, partyOf, responsibleLabel, hasMore,
}: {
  rows: RequestListRow[];
  queueState: RequestQueueState;
  custName: (r: RequestListRow) => string;
  partyOf: (r: RequestListRow) => RequestParty;
  responsibleLabel: (r: RequestListRow) => string | null;
  hasMore: boolean;
}) {
  const { t, lang } = useAppPreferences();
  const tr = t.requests;
  const tl = tr.ledger;

  const columns = useMemo(() => {
    const by = new Map<ColumnKey, RequestListRow[]>();
    for (const r of rows) {
      const display = simplifiedRequestStatus(r.status);
      const key: ColumnKey = CLOSED.includes(display) ? "closed" : display;
      by.set(key, [...(by.get(key) ?? []), r]);
    }
    const keys: ColumnKey[] = [
      ...((by.get("draft")?.length ?? 0) > 0 ? ["draft" as const] : []),
      ...OPEN_COLUMNS,
      ...((by.get("closed")?.length ?? 0) > 0 ? ["closed" as const] : []),
    ];
    return keys.map((key) => ({ key, rows: by.get(key) ?? [] }));
  }, [rows]);

  const columnLabel = (key: ColumnKey) =>
    key === "closed" ? tl.boardClosed : (t.requestStatus as Record<string, string>)[key] ?? key;

  return (
    <div className="rounded-card bg-surface p-5 sm:p-6">
      <h2 className="mb-5 font-display text-lg font-semibold text-fg">{tl.boardLabel}</h2>
      <div role="region" aria-label={tl.boardLabel} tabIndex={0} className="flex gap-4 overflow-x-auto pb-4">
        {columns.map((column) => {
          const label = columnLabel(column.key);
          const queueIds = column.rows.slice(0, 25).map((r) => r.id);
          return (
            <section key={column.key} aria-label={label} className="flex min-h-[28rem] w-[282px] shrink-0 flex-col rounded-card bg-sunk p-3">
              <div className="flex min-h-11 shrink-0 items-center gap-2 px-1 pb-3">
                <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${TONE_DOT[COLUMN_TONE[column.key]]}`} />
                <h2 className="truncate text-[13.5px] font-semibold text-fg">{label}</h2>
                <span className="ui-count bg-surface">{column.rows.length}</span>
              </div>
              <div className="flex flex-col gap-3">
                {column.rows.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-line-strong px-3 py-4 text-center text-[12.5px] text-muted">{tl.boardEmptyColumn}</p>
                ) : column.rows.map((r) => {
                  const over = isOverdue(r);
                  const href = withRequestQueueContext(r.id, buildRequestQueuePath(queueState, r.id), queueIds);
                  const dateLine = r.return_date
                    ? tl.returnShort.replace("{date}", formatDate(r.return_date, lang))
                    : r.pickup_date ? tl.neededShort.replace("{date}", formatDate(r.pickup_date, lang)) : formatDate(r.created_at, lang);
                  return (
                    <Link
                      key={r.id}
                      id={`request-${r.id}`}
                      href={href}
                      prefetch={false}
                      className="flex scroll-mt-24 flex-col gap-2.5 rounded-xl border border-line bg-surface px-4 py-5 text-fg transition-colors hover:border-muted"
                    >
                      <span className="flex items-center gap-1.5">
                        <RequestNumber className="text-[13px] text-brand-ink">{r.request_number}</RequestNumber>
                        <PartyTag>{tr.partyLabel[partyOf(r)]}</PartyTag>
                      </span>
                      <span className="truncate text-[13.5px] font-semibold leading-snug">{custName(r)}</span>
                      {r.project_name && <span className="truncate text-[12.5px] text-muted">{r.project_name}</span>}
                      {(over || column.key === "closed") && (
                        <span className="flex flex-wrap gap-1.5">
                          {column.key === "closed" && <StatusChip tone={COLUMN_TONE[simplifiedRequestStatus(r.status)]} size="sm">{columnLabel(simplifiedRequestStatus(r.status))}</StatusChip>}
                          {over && <StatusChip tone="bad" size="sm">{tr.overdueBadge}</StatusChip>}
                        </span>
                      )}
                      <span className="mt-1 flex flex-wrap items-center gap-2 border-t border-line pt-3 text-xs text-muted">
                        <span className="tabular-nums">{r.item_count} {tr.itemsCount}</span>
                        <span aria-hidden="true">·</span>
                        <span className={`truncate tabular-nums ${over ? "font-semibold text-bad" : ""}`}>{dateLine}</span>
                        <span className="flex-1" />
                        <ResponsibleCell label={responsibleLabel(r)} unassignedLabel={tr.responsibleUnassigned} compact />
                      </span>
                    </Link>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
      {hasMore && <p className="mt-2 text-xs text-muted">{tl.boardLoadedNote}</p>}
    </div>
  );
}
