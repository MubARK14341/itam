"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Plus, ClipboardList, Filter, SlidersHorizontal, ShieldCheck } from "lucide-react";
import { portalListRequests, type PortalRequestListItem } from "@/lib/portal";
import {
  isPortalActive,
  portalDashboardBucket,
  portalDisplayKey,
} from "@/lib/portal-status";
import { SearchInput, Select, inputClass } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { Button, buttonClass } from "@/components/ui/button";
import { PortalRequestRowCard } from "@/components/portal/request-row-card";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { usePortalSession } from "@/components/providers/portal-session";
import { PrivateSavedViews } from "@/components/private-saved-views";
import { createClient } from "@/lib/supabase/client";
import { useViewUrl } from "@/lib/use-view-url";
import { filterParams, parsePortalView, portalViewValues, PORTAL_VIEW_STATUSES, type FilterValues } from "@/lib/view-filters";

const STATUS_KEYS = PORTAL_VIEW_STATUSES;
const normalizeSavedView = (values: FilterValues) => portalViewValues(parsePortalView(filterParams(values)));

type View = "all" | "open" | "done";

export default function PortalRequestsPage() {
  const { t } = useAppPreferences();
  const tp = t.portal;
  const tl = tp.ledger;
  const ctx = usePortalSession();
  const [rows, setRows] = useState<PortalRequestListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewState, updateView] = useViewUrl({ initial: parsePortalView(new URLSearchParams()), parse: parsePortalView, values: portalViewValues });
  const f = useMemo(() => ({ q: viewState.q, status: viewState.status, from: viewState.from, to: viewState.to }), [viewState]);
  const bucket = viewState.bucket;
  const view = viewState.view;
  const setView = (value: View) => updateView({ view: value });
  const [moreOpen, setMoreOpen] = useState(false);
  const [actorId, setActorId] = useState<string | null>(null);
  const set = (key: keyof typeof f) => (value: string) => updateView({ [key]: value });

  useEffect(() => { portalListRequests().then(({ rows, error }) => { setRows(rows); setError(error); }); }, []);
  useEffect(() => {
    const client = createClient();
    let active = true;
    let authVersion = 0;
    const { data: subscription } = client.auth.onAuthStateChange((_event, session) => {
      authVersion += 1;
      if (active) setActorId(session?.user.id ?? null);
    });
    const requestVersion = authVersion;
    void client.auth.getUser().then(({ data, error }) => {
      if (active && authVersion === requestVersion) setActorId(error ? null : data.user?.id ?? null);
    }).catch(() => { if (active && authVersion === requestVersion) setActorId(null); });
    return () => { active = false; subscription.subscription.unsubscribe(); };
  }, []);

  const canCreate = ctx?.portal_role !== "viewer";

  // عرض سريع (الكل/المفتوحة/المكتملة) — تصفية واجهة فقط فوق نفس الصفوف.
  const inView = (r: PortalRequestListItem, v: View) => {
    if (v === "all") return true;
    const key = portalDisplayKey(r.status, r.portal_approval_status);
    return v === "open" ? isPortalActive(key) : portalDashboardBucket(key) === "completed";
  };

  const filtered = useMemo(() => (rows ?? []).filter((r) => {
    const displayStatus = portalDisplayKey(r.status, r.portal_approval_status);
    if (!inView(r, view)) return false;
    if (bucket && portalDashboardBucket(displayStatus) !== bucket) return false;
    if (f.status && displayStatus !== f.status) return false;
    const day = (r.created_at || "").slice(0, 10);
    if (f.from && day < f.from) return false;
    if (f.to && day > f.to) return false;
    if (f.q) {
      const hay = `${r.request_number} ${r.project_name ?? ""} ${r.project_city ?? ""}`.toLowerCase();
      if (!hay.includes(f.q.toLowerCase())) return false;
    }
    return true;
  }), [rows, f, bucket, view]); // eslint-disable-line react-hooks/exhaustive-deps

  const counts = useMemo(() => ({
    all: (rows ?? []).length,
    open: (rows ?? []).filter((r) => inView(r, "open")).length,
    done: (rows ?? []).filter((r) => inView(r, "done")).length,
  }), [rows]); // eslint-disable-line react-hooks/exhaustive-deps

  const hasFilters = !!(bucket || f.q || f.status || f.from || f.to || view !== "all");
  const extraActive = !!(f.status || f.from || f.to);
  const bucketLabel = bucket === "pending_pm" ? tp.home.waitingPm
    : bucket === "clarify" ? tp.home.needsClarification
    : bucket === "in_progress" ? tp.home.inProgress
    : bucket === "completed" ? tp.home.completed
    : "";
  const clearFilters = () => {
    updateView({ bucket: "", view: "all", q: "", status: "", from: "", to: "" });
  };
  const newRequestLink = (
    <Link href="/client-portal/requests/new" className={buttonClass("primary")}>
      <Plus aria-hidden="true" className="h-4 w-4" />{tp.newRequest}
    </Link>
  );

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        className="!mb-2"
        title={tp.myRequests}
        description={ctx ? `${tp.welcome}، ${ctx.contact_name}` : undefined}
        actions={canCreate ? newRequestLink : undefined}
      />

      <PrivateSavedViews actorId={ctx?.portal_enabled ? actorId : null} surface="portal-requests"
        identityKey={`${ctx?.portal_role ?? ""}|${ctx?.portal_enabled ?? false}`}
        filters={portalViewValues(viewState)} normalize={normalizeSavedView}
        onApply={(values) => updateView(parsePortalView(filterParams(values)))} />

      {/* شريط الفلاتر */}
      {rows && (rows.length > 0 || hasFilters) && (
        <div className="ui-surface flex flex-col gap-3 p-4 sm:p-5">
          <div className="flex flex-col gap-2.5 md:flex-row md:items-center">
            <SearchInput label={tp.filters.search} clearLabel={t.common.clearSearch}
              value={f.q} onChange={(e) => set("q")(e.target.value)} onClear={() => set("q")('')}
              placeholder={tp.filters.search} containerClassName="md:flex-1" />
            <div className="flex items-center gap-2">
              <div className="ui-seg grid flex-1 grid-cols-3 md:flex" role="group" aria-label={tl.viewLabel}>
                {(["all", "open", "done"] as const).map((key) => (
                  <button key={key} type="button" aria-pressed={view === key} onClick={() => setView(key)} className="ui-seg-item justify-center">
                    {key === "all" ? tl.viewAll : key === "open" ? tl.viewOpen : tl.viewDone}
                    <span className="text-[11.5px] tabular-nums text-muted">{counts[key]}</span>
                  </button>
                ))}
              </div>
              <Button variant="outline" size="icon" aria-label={tl.moreFilters} aria-expanded={moreOpen || extraActive} aria-controls="portal-requests-more-filters"
                onClick={() => setMoreOpen((o) => !o)} className={extraActive ? "border-brand text-brand-ink" : ""}>
                <SlidersHorizontal aria-hidden="true" className="h-4 w-4" />
              </Button>
            </div>
          </div>
          {(moreOpen || extraActive) && (
            <div id="portal-requests-more-filters" className="ui-surface grid grid-cols-1 gap-3 p-3 sm:grid-cols-3">
              <Select value={f.status} onChange={set("status")} placeholder={tp.filters.allStatuses} options={STATUS_KEYS.map((s) => ({ value: s, label: tp.status[s] }))} />
              <input type="date" value={f.from} onChange={(e) => set("from")(e.target.value)} aria-label={tp.filters.dateFrom} dir="ltr"
                className={`${inputClass} tabular-nums`} />
              <input type="date" value={f.to} onChange={(e) => set("to")(e.target.value)} aria-label={tp.filters.dateTo} dir="ltr"
                className={`${inputClass} tabular-nums`} />
            </div>
          )}
          <div className="flex min-h-6 flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span role="status" className="text-[13px] font-medium tabular-nums text-fg-2">
                {tl.resultsCount.replace("{shown}", String(filtered.length)).replace("{total}", String(rows.length))}
              </span>
              {bucketLabel && (
                <span className="inline-flex h-6 items-center rounded-full bg-brand-soft px-2.5 text-xs font-semibold text-brand-ink">{bucketLabel}</span>
              )}
            </div>
            {hasFilters ? (
              <button type="button" onClick={clearFilters} className="inline-flex min-h-11 items-center text-[13px] font-semibold text-brand-ink hover:underline md:min-h-8">{tp.filters.clear}</button>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-xs text-muted"><ShieldCheck aria-hidden="true" className="h-3.5 w-3.5" />{tl.scopeNote}</span>
            )}
          </div>
        </div>
      )}

      {!rows ? (
        <div className="grid gap-2.5 lg:grid-cols-2" role="status" aria-label={tp.loading}>
          {[0, 1, 2, 3].map((i) => <div key={i} className="h-32 animate-pulse rounded-card border border-line bg-sunk" />)}
        </div>
      ) : error ? (
        <div role="alert" className="rounded-card bg-bad-soft p-6 text-center text-[13.5px] text-bad">{tp.loadError}{(tp.err as Record<string, string>)[error] ?? error}</div>
      ) : rows.length === 0 ? (
        <div className="ui-surface">
          <EmptyState icon={ClipboardList} title={tp.empty} description={tp.emptyHint} action={canCreate ? newRequestLink : undefined} />
        </div>
      ) : filtered.length === 0 ? (
        <div className="ui-surface">
          <EmptyState icon={Filter} title={tp.filters.noResults}
            action={<Button variant="outline" onClick={clearFilters}>{tp.filters.clear}</Button>} />
        </div>
      ) : (
        <ul className="grid gap-4 lg:grid-cols-2">
          {filtered.map((r) => <li key={r.id} className="flex flex-col [&>a]:flex-1"><PortalRequestRowCard r={r} /></li>)}
        </ul>
      )}
    </div>
  );
}
