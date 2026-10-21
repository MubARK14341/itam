"use client";

import { useAppPreferences } from "@/components/providers/app-preferences-provider";

const BLOCK = "animate-pulse rounded-card bg-sunk";

export default function DashboardLoading() {
  const { t } = useAppPreferences();
  return (
    <div role="status" className="dashboard-command-center mx-auto min-w-0 max-w-[1600px] space-y-5 pb-6" aria-busy="true" aria-live="polite" aria-label={t.dashboard.v6.states.loading}>
      <div className="space-y-2">
        <div className="h-4 w-56 animate-pulse rounded bg-sunk" />
        <div className="h-8 w-64 animate-pulse rounded-lg bg-sunk" />
        <div className="h-4 w-80 max-w-full animate-pulse rounded bg-sunk" />
      </div>
      <div className={`${BLOCK} h-72`} />
      <div className={`${BLOCK} h-44`} />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className={`${BLOCK} h-80`} />
        <div className={`${BLOCK} h-80`} />
      </div>
      <div className={`${BLOCK} h-64`} />
    </div>
  );
}
