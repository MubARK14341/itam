"use client";

import { useAppPreferences } from "@/components/providers/app-preferences-provider";

export default function AppLoading() {
  const { t } = useAppPreferences();

  return (
    <div aria-busy="true" aria-live="polite" className="space-y-4">
      <span className="sr-only">{t.common.loading}</span>
      <div className="space-y-2">
        <div className="h-8 w-48 animate-pulse rounded-lg bg-sunk" />
        <div className="h-4 w-72 max-w-full animate-pulse rounded bg-sunk" />
      </div>
      <div className="grid gap-px overflow-hidden rounded-card border border-line bg-line sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="space-y-3 bg-surface p-5">
            <div className="h-3 w-24 animate-pulse rounded bg-sunk" />
            <div className="h-7 w-16 animate-pulse rounded bg-sunk" />
          </div>
        ))}
      </div>
      <div className="h-80 animate-pulse rounded-card border border-line bg-surface-2" />
    </div>
  );
}
