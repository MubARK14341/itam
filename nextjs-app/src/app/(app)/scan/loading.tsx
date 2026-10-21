// (UX-1) هيكل تحميل لمسار الماسح — يظهر أثناء تحميل الحزمة/الجلب بدل شاشة فارغة.
export default function Loading() {
  return (
    <div aria-hidden="true" className="animate-pulse space-y-4">
      <div className="h-8 w-40 rounded-lg bg-sunk" />
      <div className="h-12 rounded-control border border-line bg-surface" />
      <div className="overflow-hidden rounded-card border border-line bg-surface">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex h-14 items-center gap-4 border-b border-line px-4 last:border-b-0">
            <div className="h-3.5 w-28 rounded bg-sunk" />
            <div className="h-3.5 flex-1 rounded bg-sunk" />
          </div>
        ))}
      </div>
    </div>
  );
}
