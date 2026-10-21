"use client";

import { REQUEST_STATUS_TONE } from "@/lib/tone";
import { StatusChip } from "@/components/ui/status-chip";
import { useT } from "@/components/providers/app-preferences-provider";
import { simplifiedRequestStatus } from "@/lib/request-fulfillment";
import type { RequestStatus } from "@/lib/requests";

// شارة حالة طلب العميل — مفاتيح الألوان والترجمة بقيمة القاعدة (لا تُترجَم القيمة نفسها).
export function RequestStatusBadge({ status }: { status: string }) {
  const { t } = useT();
  const displayStatus = simplifiedRequestStatus(status as RequestStatus);
  // اللون يتبع الحالة المعروضة (المبسّطة) كي لا تظهر التسمية نفسها بلونين.
  const tone = REQUEST_STATUS_TONE[displayStatus] ?? REQUEST_STATUS_TONE[status] ?? "neu";
  const label = (t.requestStatus as Record<string, string>)[displayStatus] ?? displayStatus;
  return <StatusChip tone={tone}>{label}</StatusChip>;
}
