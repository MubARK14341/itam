"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle, PackageSearch, PackageCheck, Truck, RotateCcw, ClipboardCheck, ChevronLeft, ChevronDown, Warehouse,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/form";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { StatusChip } from "@/components/ui/status-chip";
import { RequestStatusBadge } from "@/components/requests/request-status-badge";
import { PartyTag, RequestNumber, type RequestParty } from "@/components/requests/request-list-bits";
import { isOverdue, type RequestListRow } from "@/lib/requests";
import { bucketizeRequests, type WarehouseBucketKey } from "@/lib/warehouse-buckets";
import { buildRequestQueuePath, withRequestQueueContext, type RequestQueueState } from "@/lib/request-navigation";
import { formatDate } from "@/lib/format";
import { TONE_TEXT, type Tone } from "@/lib/tone";
import type { Dict } from "@/lib/i18n";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";

// ترتيب أيقونات/ألوان دلاء المستودع (عرض فقط) — الحالات نفسها في lib/warehouse-buckets.ts.
const WH_BUCKET_UI: Record<WarehouseBucketKey | "overdue", { icon: typeof PackageSearch; tone: Tone }> = {
  overdue:        { icon: AlertTriangle,  tone: "bad" },
  needsPrep:      { icon: PackageSearch,  tone: "info" },
  provisioning:   { icon: ClipboardCheck, tone: "res" },
  shortage:       { icon: AlertTriangle,  tone: "warn" },
  ready:          { icon: PackageCheck,   tone: "ok" },
  awaitingReturn: { icon: Truck,          tone: "neu" },
  returnedReview: { icon: RotateCcw,      tone: "ok" },
};

const TONE_TILE: Record<Tone, string> = {
  ok: "bg-ok-soft", res: "bg-res-soft", warn: "bg-warn-soft", bad: "bg-bad-soft", info: "bg-brand-soft", neu: "bg-sunk",
};

// ===== منظور مهام المستودع داخل الطلبات =====
// عرض تشغيلي فقط: يقسّم الطلبات بالحالة (نفس دلاء lib/warehouse-buckets.ts) في بطاقات.
// كل صف رابط إلى /requests/[id] حيث الأزرار الفعلية للدورة — لا تنفيذ inline ولا تكرار handlers.
export function WarehouseTaskView({
  rows, completedRows, loading, loadingMore, total, hasMore, onLoadMore, q, onQ, queueState, custName, partyOf,
}: {
  rows: RequestListRow[];
  completedRows: RequestListRow[];
  loading: boolean;
  loadingMore: boolean;
  total: number;
  hasMore: boolean;
  onLoadMore: () => void;
  q: string;
  onQ: (v: string) => void;
  queueState: RequestQueueState;
  custName: (r: RequestListRow) => string;
  partyOf: (r: RequestListRow) => RequestParty;
}) {
  const { t, lang } = useAppPreferences();
  const tw = t.warehouse;
  const tr = t.requests;
  const [showCompleted, setShowCompleted] = useState(false);

  const groups = useMemo(() => bucketizeRequests(rows).buckets, [rows]);
  // «مكتمل» — آخر ٢٠ فقط، من نفس البيانات المحمّلة (بلا استعلام/‏RPC جديد).
  const completed = useMemo(
    () => [...completedRows]
      .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")))
      .slice(0, 20),
    [completedRows],
  );
  const nonEmpty = groups.filter((g) => g.rows.length > 0);
  const nothing = nonEmpty.length === 0 && completed.length === 0;
  const na = (k: WarehouseBucketKey) => (tw.nextAction as Record<string, string>)[k];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3 rounded-card bg-surface p-5">
        <SearchInput label={tr.searchPlaceholder} value={q} onChange={(e) => onQ(e.target.value)}
          onClear={() => onQ("")} clearLabel={t.common.clearSearch} placeholder={tr.searchPlaceholder}
          containerClassName="w-full sm:w-80" />
        {!loading && <p className="text-[13px] text-fg-2"><span className="tabular-nums">{rows.length} / {total}</span> {tr.countLabel}</p>}
      </div>

      {loading ? (
        <Card className="flex justify-center p-12"><Spinner label={tr.loading} /></Card>
      ) : nothing ? (
        <Card><EmptyState icon={Warehouse} title={tw.empty} /></Card>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
            {nonEmpty.map((b) => (
              <TaskBucket key={b.key} bucketKey={b.key} rows={b.rows} label={tw.buckets[b.key]} next={na(b.key)}
                queueState={queueState} custName={custName} partyOf={partyOf} lang={lang} tr={tr} tw={tw} />
            ))}
          </div>

          {completed.length > 0 && (
            <Card className="overflow-hidden">
              <button type="button" onClick={() => setShowCompleted((v) => !v)} aria-expanded={showCompleted}
                className="flex w-full items-center justify-between gap-3 p-5 text-start transition-colors hover:bg-surface-2">
                <span className="flex items-center gap-2.5">
                  <PackageCheck aria-hidden="true" className="h-4 w-4 text-ok" />
                  <h2 className="font-display text-[15px] font-semibold text-fg">{tw.completedTitle}</h2>
                  <span className="ui-count">{completed.length}</span>
                </span>
                <ChevronDown aria-hidden="true" className={`h-4 w-4 text-muted transition-transform ${showCompleted ? "rotate-180" : ""}`} />
              </button>
              {showCompleted && (
                <div className="border-t border-line">
                  {completed.map((r) => (
                    <TaskRow key={r.id} r={r} next={null} queueState={queueState} queueIds={completed.map((item) => item.id)} custName={custName} partyOf={partyOf} lang={lang} tr={tr} />
                  ))}
                </div>
              )}
            </Card>
          )}
          {hasMore && (
            <div className="flex justify-center pt-1">
              <Button variant="outline" disabled={loading || loadingMore} onClick={onLoadMore}>
                {loadingMore ? tr.loading : t.reports.showMore}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function TaskBucket({
  bucketKey, rows, label, next, queueState, custName, partyOf, lang, tr, tw,
}: {
  bucketKey: WarehouseBucketKey | "overdue";
  rows: RequestListRow[];
  label: string;
  next: string;
  queueState: RequestQueueState;
  custName: (r: RequestListRow) => string;
  partyOf: (r: RequestListRow) => RequestParty;
  lang: "ar" | "en";
  tr: Dict["requests"]; tw: Dict["warehouse"];
}) {
  const ui = WH_BUCKET_UI[bucketKey];
  const [showAll, setShowAll] = useState(false);
  const queueIds = rows.slice(0, 25).map((row) => row.id);
  const visibleRows = showAll ? rows : rows.slice(0, 10);
  return (
    <section aria-label={label} className="ui-surface flex flex-col overflow-hidden">
      <div className="flex items-start gap-3 p-5 sm:p-6">
        <span aria-hidden="true" className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] ${TONE_TILE[ui.tone]} ${TONE_TEXT[ui.tone]}`}>
          <ui.icon className="h-[18px] w-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-[17px] font-semibold text-fg">{label}</h2>
          {next && <p className="mt-0.5 text-[12.5px] font-medium text-brand-ink">{next}</p>}
        </div>
        <span className="font-display text-2xl font-semibold leading-7 tabular-nums text-fg">
          {rows.length}<span className="sr-only"> {tw.countUnit}</span>
        </span>
      </div>
      <div className="border-t border-line">
        {visibleRows.map((r) => <TaskRow key={r.id} r={r} next={null} queueState={queueState} queueIds={queueIds} custName={custName} partyOf={partyOf} lang={lang} tr={tr} />)}
      </div>
      {rows.length > 10 && (
        <button
          type="button"
          onClick={() => setShowAll((value) => !value)}
          className="w-full border-t border-line px-5 py-2.5 text-[13px] font-medium text-brand-ink hover:bg-surface-2"
        >
          {showAll ? tw.showLess : tw.showRemaining.replace("{count}", String(rows.length - 10))}
        </button>
      )}
    </section>
  );
}

function TaskRow({
  r, next, queueState, queueIds, custName, partyOf, lang, tr,
}: {
  r: RequestListRow;
  next: string | null;
  queueState: RequestQueueState;
  queueIds: string[];
  custName: (r: RequestListRow) => string;
  partyOf: (r: RequestListRow) => RequestParty;
  lang: "ar" | "en";
  tr: Dict["requests"];
}) {
  const over = isOverdue(r);
  const href = withRequestQueueContext(r.id, buildRequestQueuePath(queueState, r.id), queueIds);
  return (
    <Link id={`request-${r.id}`} href={href}
      className="flex scroll-mt-24 flex-wrap items-start gap-3 border-b border-line px-5 py-5 transition-colors last:border-b-0 hover:bg-surface-2 sm:px-6">
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <RequestNumber className="text-[13px] text-brand-ink">{r.request_number}</RequestNumber>
          <PartyTag>{tr.partyLabel[partyOf(r)]}</PartyTag>
          <RequestStatusBadge status={r.status} />
          {over && <StatusChip tone="bad" size="sm">{tr.overdueBadge}</StatusChip>}
        </span>
        <span className="mt-1 block truncate text-[13.5px] font-semibold text-fg">{custName(r)}</span>
        <span className="block truncate text-[12.5px] text-muted">
          {r.project_name ? `${r.project_name} · ` : ""}<span className="tabular-nums">{r.item_count}</span> {tr.items}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-2 pt-0.5">
        <span className="flex flex-col items-end gap-0.5 text-end">
          {next && <span className="text-[11.5px] font-medium text-brand-ink">{next}</span>}
          <span className={`text-[12.5px] tabular-nums ${over ? "font-semibold text-bad" : "text-muted"}`} dir={lang === "ar" ? "rtl" : "ltr"}>
            {r.return_date ? formatDate(r.return_date, lang) : formatDate(r.created_at, lang)}
          </span>
        </span>
        <ChevronLeft aria-hidden="true" className="h-4 w-4 text-muted ltr:rotate-180" />
      </span>
    </Link>
  );
}
