"use client";

import Link from "next/link";
import { prefetchIntentProps } from "@/components/shell/route-prefetch";
import { useRouter } from "next/navigation";
import {
  Activity, ArrowDownToLine, ArrowUpFromLine, CheckCircle2, ChevronLeft, MoveRight, Pencil, RefreshCw, Undo2, UserPlus, Wrench,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { formatDateTime } from "@/lib/format";
import { toneChipClass, type Tone } from "@/lib/tone";
import type { DashboardActivityItem, WidgetResult } from "@/lib/dashboard/dashboard-types";
import { DashboardSection, DASHBOARD_LINK, LtrText } from "@/components/dashboard-v6/dashboard-ui";
import { WidgetEmpty, WidgetError, WidgetPartial } from "@/components/dashboard-v6/widget-state";

const ACTION_VISUAL: Record<string, { icon: LucideIcon; tone: Tone }> = {
  assign: { icon: UserPlus, tone: "res" },
  return: { icon: Undo2, tone: "ok" },
  transfer: { icon: MoveRight, tone: "info" },
  status_change: { icon: RefreshCw, tone: "neu" },
  maint_open: { icon: Wrench, tone: "warn" },
  maint_done: { icon: CheckCircle2, tone: "ok" },
  cons_in: { icon: ArrowDownToLine, tone: "info" },
  cons_out: { icon: ArrowUpFromLine, tone: "neu" },
  cons_adjust: { icon: Pencil, tone: "neu" },
};

export function RecentActivity({
  result,
  onRetry,
}: {
  result: WidgetResult<DashboardActivityItem[]>;
  onRetry: () => void;
}) {
  const router = useRouter();
  const { t, lang } = useAppPreferences();
  const copy = t.dashboard.v6;
  const v6Ops = copy.activity.operations as Record<string, string>;
  const legacyOps = t.activity.ops as Record<string, string>;
  return (
    <DashboardSection
      id="dashboard-activity-title"
      title={copy.sections.activity.title}
      description={copy.sections.activity.description}
      icon={Activity}
      action={<Link href="/activity" prefetch={false} {...prefetchIntentProps("/activity", router.prefetch)} className={`dashboard-interactive min-w-11 ${DASHBOARD_LINK}`}>{copy.operations.viewAll}</Link>}
      bodyClassName="px-5 pb-4"
    >
      {result.status === "error" ? (
        <WidgetError sources={result.unavailableSources} onRetry={onRetry} />
      ) : (
        <>
          <WidgetPartial result={result} />
          {result.data.length === 0 ? (
            <WidgetEmpty />
          ) : (
            <ol className="grid min-w-0 grid-cols-1 gap-x-6 lg:grid-cols-2">
              {result.data.map((item) => {
                const visual = ACTION_VISUAL[item.action] ?? { icon: Activity, tone: "neu" as Tone };
                const Icon = visual.icon;
                return (
                  <li key={item.id} className="min-w-0 border-t border-line">
                    <Link href={item.href} prefetch={false} {...prefetchIntentProps(item.href, router.prefetch)} className="dashboard-interactive group flex min-h-16 min-w-0 items-center gap-3 rounded-lg py-2.5 hover:bg-surface-2">
                      <span className={`inline-flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[9px] ${toneChipClass(visual.tone)}`}>
                        <Icon className="h-4 w-4" aria-hidden="true" />
                      </span>
                      <span className="min-w-0 flex-1 text-[13px] leading-5">
                        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                          <span className="font-semibold text-fg">{v6Ops[item.action] || legacyOps[item.action] || copy.activity.action}</span>
                          <LtrText className="min-w-0 truncate font-mono text-xs text-fg-2">{item.entityLabel}</LtrText>
                        </span>
                        <span className="block truncate text-xs text-muted">
                          {item.actorVisible ? item.actor || copy.activity.actorRestricted : copy.activity.actorRestricted}
                          {" · "}
                          <time dateTime={item.occurredAt}><LtrText>{formatDateTime(item.occurredAt, lang)}</LtrText></time>
                        </span>
                      </span>
                      <span className="sr-only">{copy.activity.view}</span>
                      <ChevronLeft className="h-4 w-4 shrink-0 text-muted ltr:rotate-180" aria-hidden="true" />
                    </Link>
                  </li>
                );
              })}
            </ol>
          )}
        </>
      )}
    </DashboardSection>
  );
}
