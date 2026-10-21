"use client";

import Link from "next/link";
import { AlertTriangle, MessageSquareReply } from "lucide-react";
import { portalDisplayKey, PORTAL_STATUS_TONE } from "@/lib/portal-status";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { StatusChip } from "@/components/ui/status-chip";
import { StageProgress, stageAriaLabel } from "@/components/self-service/stage-progress";
import { portalRequestStage } from "@/components/portal/portal-stage";
import { formatDateTime } from "@/lib/format";
import type { PortalRequestCardItem } from "@/lib/portal";

// بطاقة صف طلب — مشتركة بين لوحة البوابة الرئيسية وقائمة الطلبات (مصدر عرض واحد).
// لا تعرض أي بيانات مالية/مخزون؛ كل الحقول من portal_* RPCs المُبيّضة.
export function PortalRequestRowCard({ r }: { r: PortalRequestCardItem }) {
  const { t, lang } = useAppPreferences();
  const tp = t.portal;
  const tl = tp.ledger;
  const sk = portalDisplayKey(r.status, r.portal_approval_status);
  const stage = portalRequestStage(sk, r.status);
  const stages: [string, string, string, string] = [tl.stageReview, tl.stagePreparing, tl.stageDelivery, tl.stageCompletion];
  return (
    <Link
      href={`/client-portal/requests/${r.id}`}
      className="ui-surface flex flex-col gap-3 px-5 py-5 transition-colors hover:border-brand/40 hover:bg-surface-2"
    >
      <span className="flex items-center justify-between gap-2">
        <span className="font-mono text-[13px] font-medium text-fg-2 [unicode-bidi:isolate]" dir="ltr">{r.request_number}</span>
        <StatusChip tone={PORTAL_STATUS_TONE[sk]}>{tp.status[sk]}</StatusChip>
      </span>
      <span className="block font-display text-lg font-semibold leading-snug text-fg">{r.project_name || "—"}</span>
      <span className="block truncate text-[12.5px] tabular-nums text-muted">
        {r.project_city && <>{r.project_city} · </>}
        {tl.itemsCount.replace("{count}", String(r.item_count))} · {formatDateTime(r.created_at, lang)}
      </span>
      {r.status === "overdue" && (
        <span className="flex items-center gap-1.5 text-[12.5px] font-semibold text-bad">
          <AlertTriangle aria-hidden="true" className="h-4 w-4 shrink-0" />{tl.overdueReturn}
        </span>
      )}
      {sk === "clarify" && (
        <span className="flex items-center gap-1.5 text-[12.5px] font-semibold text-warn">
          <MessageSquareReply aria-hidden="true" className="h-4 w-4 shrink-0" />{tl.clarifyAlert}
        </span>
      )}
      <StageProgress className="mt-1 border-t border-line pt-4" stages={stages} model={stage} label={stageAriaLabel(tl.stageOf, tl.stageClosed, stages, stage.current)} />
    </Link>
  );
}
