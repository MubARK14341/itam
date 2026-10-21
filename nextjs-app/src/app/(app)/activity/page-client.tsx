"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  UserPlus, Undo2, MoveRight, RefreshCw, Trash2, Wrench, CheckCircle2,
  ArrowDownToLine, ArrowUpFromLine, Pencil, History, Info, ArrowLeft, ChevronDown,
} from "lucide-react";
import { SearchInput, Select, inputClass } from "@/components/ui/form";
import { EmptyState } from "@/components/ui/empty-state";
import { getActivity, type ActivityEvent } from "@/lib/queries";
import { useSession } from "@/lib/session";
import { useFeatureExposure } from "@/components/providers/feature-exposure-provider";
import { FeatureRoute } from "@/components/feature-gate";
import { dateKeyInTimeZone, formatDate } from "@/lib/format";
import { interpolate, type Dict, type Lang } from "@/lib/i18n";
import { toneChipClass, type Tone } from "@/lib/tone";
import type { AssetStatus } from "@/lib/types";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { PageHeader } from "@/components/ui/page-header";

const OP_ICON: Record<string, any> = {
  assign: UserPlus, return: Undo2, transfer: MoveRight, status_change: RefreshCw, dispose: Trash2,
  maint_open: Wrench, maint_done: CheckCircle2, maint_update: Wrench, cons_in: ArrowDownToLine, cons_out: ArrowUpFromLine,
  cons_adjust: Pencil, asset_edit: Pencil,
};

const OP_TONE: Record<string, Tone> = {
  assign: "res",
  return: "ok",
  transfer: "info",
  status_change: "warn",
  dispose: "neu",
  maint_open: "bad",
  maint_done: "ok",
  maint_update: "warn",
  cons_in: "ok",
  cons_out: "info",
  cons_adjust: "neu",
  asset_edit: "res",
};

const statusAr = (t: Dict, s: string | null) => (s ? t.status[s as AssetStatus] ?? s : "—");

function sentence(e: ActivityEvent, t: Dict): string {
  const tag = e.entityLabel ?? "—";
  const s = t.activity.sentence;
  switch (e.op) {
    case "assign": return e.employee ? interpolate(s.assignTo, { tag, emp: e.employee }) : interpolate(s.assign, { tag });
    case "return": return interpolate(s.return, { tag });
    case "transfer": return `${e.toLoc ? interpolate(s.transferTo, { tag, to: e.toLoc }) : interpolate(s.transfer, { tag })}${e.fromLoc ? interpolate(s.transferFrom, { from: e.fromLoc }) : ""}`;
    case "status_change": return interpolate(s.status_change, { tag, from: statusAr(t, e.fromStatus), to: statusAr(t, e.toStatus) });
    case "dispose": return interpolate(s.dispose, { tag });
    case "maint_open": return interpolate(s.maint_open, { tag });
    case "maint_done": return interpolate(s.maint_done, { tag });
    case "maint_update": return interpolate(s.maint_update, { tag });
    case "cons_out": return interpolate(s.cons_out, { tag, qty: e.qty ?? "" });
    case "cons_in": return interpolate(s.cons_in, { tag, qty: e.qty ?? "" });
    case "cons_adjust": return interpolate(s.cons_adjust, { tag });
    case "asset_edit": return interpolate(s.asset_edit, { tag });
    default: return tag;
  }
}

function detail(e: ActivityEvent): string | null {
  if (e.op === "maint_open") return e.text || null;
  if (e.op === "status_change") return e.note && e.note !== "تغيير حالة" ? e.note : null;
  if (e.kind === "consumable") return e.note || null;
  return null;
}

/** Before → after pairs already present on the event (display only, no extra data). */
function changes(e: ActivityEvent, t: Dict): { field: string; before: string; after: string }[] {
  const a = t.activity;
  const rows: { field: string; before: string; after: string }[] = [];
  if (e.fromStatus || e.toStatus) rows.push({ field: a.fieldStatus, before: statusAr(t, e.fromStatus), after: statusAr(t, e.toStatus) });
  if (e.fromLoc || e.toLoc) rows.push({ field: a.fieldLocation, before: e.fromLoc ?? "—", after: e.toLoc ?? "—" });
  if (e.employee) rows.push({ field: a.fieldEmployee, before: "—", after: e.employee });
  if (e.qty != null) rows.push({ field: a.fieldQty, before: "—", after: String(e.qty) });
  return rows;
}

function formatTime(at: string, lang: Lang): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(lang === "en" ? "en-US" : "ar-SA-u-ca-gregory-nu-latn", {
    timeZone: "Asia/Riyadh", hour: "numeric", minute: "2-digit", hour12: true,
  }).format(date);
}

export default function ActivityPage() {
  const { role, loading: roleLoading } = useSession();
  const { t, lang } = useAppPreferences();
  const { isVisible } = useFeatureExposure();
  // إظهار تدريجي: الفلاتر المتقدمة (العملية/الكيان/المنفّذ/التواريخ) من 90 — البحث النصي يبقى.
  const expAdvFilters = isVisible("activity.advancedFilters");
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [op, setOp] = useState(""); const [actor, setActor] = useState("");
  const [entity, setEntity] = useState(""); const [from, setFrom] = useState(""); const [to, setTo] = useState("");
  const [q, setQ] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (roleLoading) return;
    const includeAudit = role === "admin" || role === "it_manager";
    getActivity({ includeAudit }).then(({ events, error }) => {
      setEvents(events); setLoading(false);
      setLoadError(error ? t.activity.loadError + error : null);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role, roleLoading]);

  const actors = useMemo(
    () => Array.from(new Set(events.map((e) => e.actor).filter(Boolean))) as string[],
    [events]
  );

  const ops = t.activity.ops as Record<string, string>;

  const filtered = useMemo(() => events.filter((e) => {
    if (op && e.op !== op) return false;
    if (actor && e.actor !== actor) return false;
    if (entity && e.entity !== entity) return false;
    if (from && e.at.slice(0, 10) < from) return false;
    if (to && e.at.slice(0, 10) > to) return false;
    if (q) {
      const hay = `${sentence(e, t)} ${e.entityLabel ?? ""} ${detail(e) ?? ""} ${e.actor ?? ""}`.toLowerCase();
      if (!hay.includes(q.toLowerCase())) return false;
    }
    return true;
  }), [events, op, actor, entity, from, to, q, t]);

  // تجميع حسب اليوم (بتوقيت الرياض) — عرض فقط فوق القائمة المفلترة نفسها.
  const days = useMemo(() => {
    const groups: { key: string; items: ActivityEvent[] }[] = [];
    for (const e of filtered) {
      const date = new Date(e.at);
      const key = Number.isNaN(date.getTime()) ? e.at.slice(0, 10) : dateKeyInTimeZone(date);
      const last = groups[groups.length - 1];
      if (last && last.key === key) last.items.push(e);
      else groups.push({ key, items: [e] });
    }
    return groups;
  }, [filtered]);

  const opStats = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of filtered) counts.set(e.op, (counts.get(e.op) ?? 0) + 1);
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [filtered]);

  const actorStats = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of filtered) if (e.actor) counts.set(e.actor, (counts.get(e.actor) ?? 0) + 1);
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 6);
  }, [filtered]);

  const todayKey = dateKeyInTimeZone();
  const yesterdayKey = dateKeyInTimeZone(new Date(Date.now() - 864e5));
  const hasFilters = Boolean(op || actor || entity || from || to || q);
  const maxOp = opStats[0]?.[1] ?? 1;

  function clearFilters() {
    setOp(""); setActor(""); setEntity(""); setFrom(""); setTo(""); setQ("");
  }

  return (
    <FeatureRoute feature="activity.page">
    <div>
      <PageHeader
        title={t.activity.title}
        description={loading ? t.common.loading : `${filtered.length} ${t.activity.countLabel}`}
      />

      {loadError && (
        <div role="alert" className="mb-5 rounded-control bg-bad-soft p-3 text-sm text-bad">
          {loadError}
        </div>
      )}

      <div className="mb-6 flex flex-wrap items-center gap-3 rounded-card bg-surface p-5 sm:p-6">
        <SearchInput label={t.activity.searchPlaceholder} value={q} onChange={(e) => setQ(e.target.value)}
          onClear={() => setQ("")} clearLabel={t.common.clearSearch}
          placeholder={t.activity.searchPlaceholder} containerClassName="w-full sm:w-80" />
        {expAdvFilters && (
          <>
            <div className="w-full sm:w-48">
              <Select value={op} onChange={setOp} placeholder={t.activity.allOps}
                options={Object.entries(ops).map(([v, l]) => ({ value: v, label: l }))} />
            </div>
            <div className="w-full sm:w-48">
              <Select value={entity} onChange={setEntity} placeholder={t.activity.allEntities}
                options={[{ value: "asset", label: t.activity.assetsEntity }, { value: "consumable", label: t.activity.consumablesEntity }]} />
            </div>
            {actors.length > 0 && (
              <div className="w-full sm:w-48">
                <Select value={actor} onChange={setActor} placeholder={t.activity.allActors}
                  options={actors.map((a) => ({ value: a, label: a }))} />
              </div>
            )}
            <div className="flex w-full items-center gap-2 sm:w-auto">
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label={t.activity.fromDate} dir="ltr" title={t.activity.fromDate}
                className={`${inputClass} sm:w-40`} />
              <span aria-hidden="true" className="text-muted">–</span>
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label={t.activity.toDate} dir="ltr" title={t.activity.toDate}
                className={`${inputClass} sm:w-40`} />
            </div>
          </>
        )}
        {hasFilters && (
          <button type="button" onClick={clearFilters} className="ui-button ui-button-ghost ui-button-sm text-brand-ink">
            {t.activity.clearFilters}
          </button>
        )}
      </div>

      <div className="grid min-w-0 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_18.75rem]">
        <section aria-label={t.activity.timelineLabel} className="ui-surface min-w-0">
          <div className="flex min-h-12 items-center justify-between gap-3 rounded-t-card border-b border-line px-5 text-[13px] text-fg-2">
            <span><b className="font-semibold tabular-nums">{loading ? "—" : filtered.length}</b> {t.activity.countLabel}</span>
          </div>
          {loading ? (
            <div className="space-y-3 p-5">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-14 animate-pulse rounded-lg bg-sunk" />)}</div>
          ) : filtered.length === 0 ? (
            <EmptyState icon={History} title={t.activity.empty}
              action={hasFilters ? <button type="button" onClick={clearFilters} className="ui-button ui-button-outline ui-button-sm">{t.activity.clearFilters}</button> : undefined} />
          ) : (
            days.map((day) => {
              const headingId = `activity-day-${day.key}`;
              const label = day.key === todayKey ? t.activity.today : day.key === yesterdayKey ? t.activity.yesterday : null;
              return (
                <div key={day.key} role="group" aria-labelledby={headingId}>
                  <h2 id={headingId} className="sticky top-14 z-10 flex items-baseline gap-2.5 border-b border-line bg-surface-2 px-5 py-2.5 md:top-[60px]">
                    <span className="font-display text-sm font-semibold text-fg">{label ?? formatDate(day.key, lang)}</span>
                    {label && <span className="text-[12.5px] font-normal text-muted">{formatDate(day.key, lang)}</span>}
                    <span className="ms-auto text-xs font-normal tabular-nums text-muted">{interpolate(t.activity.dayCount, { n: day.items.length })}</span>
                  </h2>
                  <ol className="divide-y divide-line">
                    {day.items.map((e) => {
                      const Icon = OP_ICON[e.op] ?? RefreshCw;
                      const d = detail(e);
                      const diff = changes(e, t);
                      return (
                        <li key={e.id} className="flex gap-4 px-5 py-5 sm:px-6">
                          <span className={`mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${toneChipClass(OP_TONE[e.op] ?? "neu")}`}>
                            <Icon aria-hidden="true" className="h-[18px] w-[18px]" />
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-start justify-between gap-3">
                              <p className="min-w-0 text-sm leading-6 text-fg">
                                {e.actor && <b className="font-semibold">{e.actor} · </b>}
                                {sentence(e, t)}
                              </p>
                              <time dateTime={e.at} className="shrink-0 pt-0.5 text-[12.5px] tabular-nums text-muted" dir="ltr">{formatTime(e.at, lang)}</time>
                            </div>
                            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-muted">
                              <span className={`ui-chip h-[22px] px-2 text-[11.5px] ${toneChipClass(OP_TONE[e.op] ?? "neu")}`}>{ops[e.op] ?? e.op}</span>
                              {d && <span className="min-w-0 break-words">{d}</span>}
                              {e.href && <Link href={e.href} className="font-medium text-brand-ink hover:underline">{t.activity.viewDetails}</Link>}
                            </div>
                            {diff.length > 0 && (
                              <details className="group mt-2">
                                <summary className="inline-flex min-h-8 cursor-pointer list-none items-center gap-1 rounded-md text-[12.5px] font-medium text-brand-ink hover:underline max-md:min-h-11 [&::-webkit-details-marker]:hidden">
                                  {t.activity.details}
                                  <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
                                </summary>
                                <div tabIndex={0} className="mt-2 overflow-x-auto rounded-control border border-line">
                                  <table className="w-full min-w-[18rem] text-[13px]">
                                    <thead className="bg-surface-2 text-[11.5px] font-semibold text-muted">
                                      <tr>
                                        <th scope="col" className="px-3 py-1.5 text-start">{t.activity.field}</th>
                                        <th scope="col" className="px-3 py-1.5 text-start">{t.activity.before}</th>
                                        <th scope="col" className="w-6 px-1 py-1.5"><span className="sr-only">→</span></th>
                                        <th scope="col" className="px-3 py-1.5 text-start">{t.activity.after}</th>
                                      </tr>
                                    </thead>
                                    <tbody className="divide-y divide-line border-t border-line">
                                      {diff.map((row) => (
                                        <tr key={row.field}>
                                          <td className="px-3 py-2 text-muted">{row.field}</td>
                                          <td className="px-3 py-2 text-muted line-through decoration-line-strong">{row.before}</td>
                                          <td className="px-1 py-2 text-muted"><ArrowLeft aria-hidden="true" className="h-3.5 w-3.5 ltr:rotate-180" /></td>
                                          <td className="px-3 py-2 font-medium text-fg">{row.after}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              </details>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                </div>
              );
            })
          )}
        </section>

        <aside aria-label={t.activity.summaryTitle} className="ui-surface min-w-0 overflow-hidden">
          <div className="p-5 sm:p-6">
            <h2 className="font-display text-[17px] font-semibold text-fg">{t.activity.summaryTitle}</h2>
            <p className="mt-3 flex items-baseline gap-2">
              <span className="font-display text-[34px] font-semibold leading-none tabular-nums text-fg" dir="ltr">{loading ? "—" : filtered.length}</span>
              <span className="text-[13px] text-muted">{t.activity.inFilters}</span>
            </p>
          </div>
          {opStats.length > 0 && (
            <div className="border-t border-line px-5 py-4">
              <h3 className="mb-2.5 text-[13px] font-semibold text-muted">{t.activity.byOperation}</h3>
              <ul className="space-y-2">
                {opStats.map(([key, n]) => (
                  <li key={key} className="grid grid-cols-[6.5rem_minmax(0,1fr)_2rem] items-center gap-2.5 text-[12.5px]">
                    <span className="truncate text-fg-2">{ops[key] ?? key}</span>
                    <span aria-hidden="true" className="block h-1.5 overflow-hidden rounded-full bg-sunk">
                      <span className="block h-full rounded-full bg-brand" style={{ width: `${Math.round((n / maxOp) * 100)}%` }} />
                    </span>
                    <span className="text-end font-semibold tabular-nums" dir="ltr">{n}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {actorStats.length > 0 && (
            <div className="border-t border-line px-5 py-4">
              <h3 className="mb-2 text-[13px] font-semibold text-muted">{t.activity.byActor}</h3>
              <div role={expAdvFilters ? "group" : undefined} aria-label={expAdvFilters ? t.activity.filterByActor : undefined} className="flex flex-col gap-0.5">
                {actorStats.map(([name, n]) => {
                  const body = (
                    <>
                      <span className="ui-avatar h-7 w-7 shrink-0 text-[11px]" aria-hidden="true">{name.trim().slice(0, 2)}</span>
                      <span className="min-w-0 flex-1 truncate font-medium text-fg">{name}</span>
                      <span className="font-semibold tabular-nums text-fg-2" dir="ltr">{n}</span>
                    </>
                  );
                  return expAdvFilters ? (
                    <button key={name} type="button" aria-pressed={actor === name} onClick={() => setActor(actor === name ? "" : name)}
                      className={`flex min-h-10 items-center gap-2.5 rounded-lg px-2 text-start text-[13px] transition-colors max-md:min-h-11 ${actor === name ? "bg-brand-soft" : "hover:bg-surface-2"}`}>
                      {body}
                    </button>
                  ) : (
                    <div key={name} className="flex min-h-10 items-center gap-2.5 px-2 text-[13px]">{body}</div>
                  );
                })}
              </div>
            </div>
          )}
          <p className="flex gap-2.5 border-t border-line bg-surface-2 px-5 py-3.5 text-[12.5px] leading-5 text-muted">
            <Info aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
            {t.activity.readOnlyNote}
          </p>
        </aside>
      </div>
    </div>
    </FeatureRoute>
  );
}
