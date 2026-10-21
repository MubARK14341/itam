// (UX-1) هيكل تحميل لمسار طلبات الشراء — يظهر أثناء تحميل الحزمة/الجلب بدل شاشة فارغة.
export default function Loading() {
  return (
    <div className="animate-pulse" aria-hidden="true">
      <div className="mb-2 h-8 w-52 rounded-lg bg-sunk" />
      <div className="mb-6 h-4 w-96 max-w-full rounded bg-sunk" />
      <div className="ui-surface overflow-hidden">
        <div className="border-b border-line px-4 py-3">
          <div className="h-[38px] w-60 max-w-full rounded-control bg-sunk" />
        </div>
        <div className="divide-y divide-line">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 px-4 py-4">
              <div className="h-4 w-28 rounded bg-sunk" />
              <div className="h-4 flex-1 rounded bg-sunk" />
              <div className="h-6 w-20 rounded-full bg-sunk" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
