/** Ledger loading skeleton for /reports (route loading.tsx and the page's first data fetch). */
export function ReportsSkeleton() {
  return (
    <div className="animate-pulse space-y-[18px]" aria-hidden="true">
      <div className="space-y-2">
        <div className="h-8 w-40 rounded-lg bg-sunk" />
        <div className="h-4 w-72 max-w-full rounded bg-sunk" />
      </div>
      <div className="flex gap-6 border-b border-line pb-3">
        {Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-5 w-20 rounded bg-sunk" />)}
      </div>
      <div className="h-[74px] rounded-card border border-line bg-surface" />
      <div className="grid grid-cols-2 overflow-hidden rounded-card border border-line bg-surface lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="space-y-2 px-5 py-4">
            <div className="h-3.5 w-20 rounded bg-sunk" />
            <div className="h-8 w-16 rounded bg-sunk" />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-[18px] lg:grid-cols-2">
        <div className="h-72 rounded-card border border-line bg-surface" />
        <div className="h-72 rounded-card border border-line bg-surface" />
      </div>
    </div>
  );
}
