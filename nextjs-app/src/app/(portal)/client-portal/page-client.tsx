"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Plus, ClipboardList, Clock, AlertTriangle, ChevronLeft, MessageSquareReply, ShieldCheck } from "lucide-react";
import { portalGetRequestDashboard, type PortalRequestDashboard } from "@/lib/portal";
import { PortalRequestRowCard } from "@/components/portal/request-row-card";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { buttonClass } from "@/components/ui/button";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { usePortalSession } from "@/components/providers/portal-session";
import { formatDate } from "@/lib/format";
import { TONE_TEXT, type Tone } from "@/lib/tone";

// لوحة بوابة العميل الرئيسية — ملخص + آخر الطلبات + إجراء إنشاء.
// المصدر: portal_get_request_dashboard (معزول لكل دور من الخادم؛ نفس عزل portal_list_requests).
// لا بيانات مالية/مخزون/أصول/PR إطلاقًا (مضمون في القاعدة).
export default function ClientPortalHome() {
  const { t, lang } = useAppPreferences();
  const tp = t.portal;
  const tl = tp.ledger;
  const ctx = usePortalSession();
  const [dash, setDash] = useState<PortalRequestDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => { portalGetRequestDashboard().then(({ data, error }) => { setDash(data); setError(error); setLoaded(true); }); }, []);

  const canCreate = ctx?.portal_role !== "viewer";
  const isPm = ctx?.portal_role === "project_manager";
  // كل الأنواع معطّلة؟ (لا نوع طلب مسموح لهذا العميل)
  const noTypes = !!ctx && !ctx.allow_rental_requests && !ctx.allow_purchase_requests
    && !ctx.allow_maintenance_requests && !ctx.allow_custom_requests;
  const showPmCard = isPm || (dash?.waiting_pm_approval ?? 0) > 0;
  const greetName = ctx?.contact_name || ctx?.customer_name || "";
  const v = (n: number | undefined) => (dash ? (n ?? 0) : "—");
  const pmWaiting = isPm && (dash?.waiting_pm_approval ?? 0) > 0;
  const clarifyWaiting = (dash?.needs_clarification ?? 0) > 0;

  const kpis: { key: string; label: string; value: number | string; href?: string; dot?: Tone; tone?: Tone }[] = [
    { key: "open", label: tp.home.openRequests, value: v(dash?.open_requests) },
    ...(showPmCard ? [{ key: "pm", label: tp.home.waitingPm, value: v(dash?.waiting_pm_approval), href: "/client-portal/requests?bucket=pending_pm", dot: "warn" as Tone, tone: (dash?.waiting_pm_approval ?? 0) > 0 ? "warn" as Tone : undefined }] : []),
    { key: "clarify", label: tp.home.needsClarification, value: v(dash?.needs_clarification), href: "/client-portal/requests?bucket=clarify", dot: "warn", tone: clarifyWaiting ? "warn" : undefined },
    { key: "progress", label: tp.home.inProgress, value: v(dash?.in_progress), href: "/client-portal/requests?bucket=in_progress", dot: "info" },
    { key: "completed", label: tp.home.completed, value: v(dash?.completed), href: "/client-portal/requests?bucket=completed", dot: "ok" },
  ];
  const kpiCols = kpis.length === 5 ? "lg:grid-cols-5" : "lg:grid-cols-4";

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        className="!mb-0"
        eyebrow={<span className="tabular-nums">{formatDate(new Date().toISOString(), lang)}</span>}
        title={tp.home.title}
        description={ctx ? <>{tp.welcome}، {greetName}{ctx.customer_name && ctx.customer_name !== greetName ? <> · {ctx.customer_name}</> : null}</> : undefined}
        actions={canCreate ? (
          <Link href="/client-portal/requests/new" className={buttonClass("primary", "md", "max-sm:w-full")}>
            <Plus aria-hidden="true" className="h-4 w-4" />{tp.newRequest}
          </Link>
        ) : undefined}
      />

      {noTypes && (
        <div role="note" className="flex items-start gap-2.5 rounded-card bg-warn-soft p-4 text-[13.5px] text-warn">
          <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{tp.home.noTypesNotice}</span>
        </div>
      )}

      {(pmWaiting || clarifyWaiting) && (
        <section aria-labelledby="portal-home-attention" className="flex flex-col gap-2">
          <h2 id="portal-home-attention" className="font-display text-[17px] font-semibold text-fg">{tl.needsAction}</h2>
          <div className="grid gap-2 md:grid-cols-2">
            {pmWaiting && (
              <Link href="/client-portal/requests" className="flex min-h-16 items-center gap-3 rounded-card bg-warn-soft px-3.5 py-3 text-fg transition-[filter] hover:brightness-[.97]">
                <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-surface text-warn"><Clock aria-hidden="true" className="h-[18px] w-[18px]" /></span>
                <span className="min-w-0 flex-1 text-[14px] font-semibold">{tp.home.waitingApprovalHint}: <span className="tabular-nums">{dash?.waiting_pm_approval}</span></span>
                <ChevronLeft aria-hidden="true" className="h-4 w-4 shrink-0 text-muted ltr:rotate-180" />
              </Link>
            )}
            {clarifyWaiting && (
              <Link href="/client-portal/requests?bucket=clarify" className="flex min-h-16 items-center gap-3 rounded-card bg-warn-soft px-3.5 py-3 text-fg transition-[filter] hover:brightness-[.97]">
                <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-surface text-warn"><MessageSquareReply aria-hidden="true" className="h-[18px] w-[18px]" /></span>
                <span className="min-w-0 flex-1 text-[14px] font-semibold">{tl.clarifyAlert}: <span className="tabular-nums">{dash?.needs_clarification}</span></span>
                <ChevronLeft aria-hidden="true" className="h-4 w-4 shrink-0 text-muted ltr:rotate-180" />
              </Link>
            )}
          </div>
        </section>
      )}

      {/* بطاقات الملخص */}
      <section aria-label={tl.summaryLabel} className={`grid grid-cols-2 gap-3 ${kpiCols}`}>
        {kpis.map((k, i) => {
          const body = (
            <>
              <span className="flex items-center gap-1.5 text-[12.5px] font-medium text-fg-2">
                {k.dot && <span aria-hidden="true" className={`h-[7px] w-[7px] rounded-full ${k.dot === "warn" ? "bg-warn" : k.dot === "ok" ? "bg-ok" : "bg-brand"}`} />}
                {k.label}
              </span>
              <span className={`font-display text-[32px] font-semibold leading-10 tabular-nums ${k.tone ? TONE_TEXT[k.tone] : "text-fg"}`}>{k.value}</span>
            </>
          );
          const cell = `ui-surface flex min-w-0 flex-col gap-3 px-4 py-4 sm:px-5 ${i === kpis.length - 1 && kpis.length % 2 === 1 ? "max-lg:col-span-2" : ""}`;
          return k.href ? (
            <Link key={k.key} href={k.href} aria-label={`${k.label}: ${k.value}`} className={`${cell} transition-colors hover:bg-surface-2`}>{body}</Link>
          ) : (
            <div key={k.key} className={cell}>{body}</div>
          );
        })}
      </section>

      {/* آخر الطلبات */}
      <section aria-labelledby="portal-home-recent" className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h2 id="portal-home-recent" className="font-display text-[17px] font-semibold text-fg">{tp.home.recentRequests}</h2>
          {dash && dash.total_my_requests > 0 && (
            <Link href="/client-portal/requests" className="inline-flex min-h-11 items-center gap-1 text-[13px] font-semibold text-brand-ink hover:underline">
              {tp.home.viewAll}<ChevronLeft aria-hidden="true" className="h-4 w-4 ltr:rotate-180" />
            </Link>
          )}
        </div>

        {!loaded ? (
          <div className="grid gap-2.5 lg:grid-cols-2" role="status" aria-label={tp.loading}>
            {[0, 1, 2].map((i) => <div key={i} className="h-32 animate-pulse rounded-card border border-line bg-sunk" />)}
          </div>
        ) : error ? (
          <div role="alert" className="rounded-card bg-bad-soft p-6 text-center text-[13.5px] text-bad">{tp.loadError}{(tp.err as Record<string, string>)[error] ?? error}</div>
        ) : !dash || dash.recent_requests.length === 0 ? (
          <div className="ui-surface">
            <EmptyState
              icon={ClipboardList}
              title={tp.empty}
              description={tp.emptyHint}
              action={canCreate ? <Link href="/client-portal/requests/new" className={buttonClass("primary")}><Plus aria-hidden="true" className="h-4 w-4" />{tp.newRequest}</Link> : undefined}
            />
          </div>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {dash.recent_requests.map((r) => <PortalRequestRowCard key={r.id} r={r} />)}
          </div>
        )}
      </section>

      <p className="flex items-center justify-center gap-1.5 text-xs text-muted">
        <ShieldCheck aria-hidden="true" className="h-3.5 w-3.5" />{tl.scopeNote}
      </p>
    </div>
  );
}
