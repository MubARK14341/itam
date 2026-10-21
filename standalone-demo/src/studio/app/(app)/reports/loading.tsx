import { ReportsSkeleton } from "@/components/reports/reports-skeleton";

// (UX-1) هيكل تحميل لمسار التقارير — يظهر أثناء تحميل الحزمة/الجلب بدل شاشة فارغة 1-4 ثوانٍ.
export default function Loading() {
  return <ReportsSkeleton />;
}
