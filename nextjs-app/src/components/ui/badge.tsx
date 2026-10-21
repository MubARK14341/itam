"use client";

import type { AssetStatus } from "@/lib/types";
import { ASSET_STATUS_TONE } from "@/lib/tone";
import { StatusChip } from "@/components/ui/status-chip";
import { useT } from "@/components/providers/app-preferences-provider";

export function StatusBadge({ status }: { status: AssetStatus }) {
  const { t } = useT();
  return <StatusChip tone={ASSET_STATUS_TONE[status]}>{t.status[status] ?? status}</StatusChip>;
}
