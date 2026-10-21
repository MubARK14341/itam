"use client";

import { useT } from "@/components/providers/app-preferences-provider";

export function DemoEnvironmentBadge() {
  const { t } = useT();

  return (
    <div
      role="status"
      aria-label={`${t.app.demoBadge}: ${t.app.demoDisclosure}`}
      className="pointer-events-none fixed bottom-2 end-2 z-[80] max-w-[calc(100vw-1rem)] rounded-control border border-warn/30 bg-warn-soft px-3 py-2 text-start"
    >
      <div className="text-[11px] font-bold tracking-[0.14em] text-warn">
        {t.app.demoBadge}
      </div>
      <div className="text-[10px] text-fg-2">
        {t.app.demoDisclosure}
      </div>
    </div>
  );
}
