// ============================================================================
//  المصدر الموحد لدلاء مهام المستودع (Warehouse Task Buckets) — بلا أي اتصال شبكة.
//  تجميع الطلبات حسب حالتها التشغيلية. يستهلكه:
//    1) صفحة مهام المستودع (/warehouse) — القوائم الكاملة.
//    2) شريط «مهام المستودع اليوم» في لوحة المعلومات — العدّادات.
//  القاعدة: تعريف واحد للحالات ⇒ عدّاد الشريط يطابق قائمة الصفحة 100%.
//  المتأخر (isOverdue) يُعرض في دلوه الخاص فقط ولا يُكرَّر في «بانتظار الإرجاع».
// ============================================================================

import { isOverdue, type RequestListRow } from "@/lib/requests";

export type WarehouseBucketKey =
  | "needsPrep" | "provisioning" | "shortage" | "ready" | "awaitingReturn" | "returnedReview";

// ترتيب الدلاء يعكس تسلسل دورة الحياة التشغيلية.
export const WAREHOUSE_BUCKETS: { key: WarehouseBucketKey; statuses: readonly string[] }[] = [
  { key: "needsPrep",      statuses: ["approved"] },
  { key: "provisioning",   statuses: ["auto_provisioning", "provisioned", "preparing"] },
  { key: "shortage",       statuses: ["stock_shortage"] },
  { key: "ready",          statuses: ["ready_for_pickup"] },
  { key: "awaitingReturn", statuses: ["delivered", "partially_returned"] },
  { key: "returnedReview", statuses: ["returned"] },
];

// The exact existing workflow states that make a request operationally relevant.
// The list query uses this to avoid filling a 100-row page with completed/admin-only work.
export const WAREHOUSE_REQUEST_STATUSES = WAREHOUSE_BUCKETS.flatMap((bucket) => bucket.statuses);

export interface WarehouseBucket {
  key: WarehouseBucketKey;
  statuses: readonly string[];
  rows: RequestListRow[];
}

export function warehouseBucketKeyForStatus(status: string): WarehouseBucketKey | null {
  const bucket = WAREHOUSE_BUCKETS.find((x) => x.statuses.includes(status));
  if (bucket) return bucket.key;
  if (status === "overdue") return "awaitingReturn";
  return null;
}

// تصنيف واحد تستهلكه صفحة الطلبات وDashboard؛ المتأخر يبقى داخل فئته ويتصدرها.
export function bucketizeRequests(rows: RequestListRow[]): {
  buckets: WarehouseBucket[];
  overdue: RequestListRow[];
} {
  const overdue = rows.filter((r) => isOverdue(r));
  const buckets: WarehouseBucket[] = WAREHOUSE_BUCKETS.map((b) => ({
    ...b,
    rows: rows
      .filter((r) => warehouseBucketKeyForStatus(r.status) === b.key)
      .sort((a, c) => compareWarehouseWork(a, c, b.key)),
  }));
  return { buckets, overdue };
}

function compareWarehouseWork(a: RequestListRow, b: RequestListRow, bucket: WarehouseBucketKey): number {
  const overdueOrder = Number(isOverdue(b)) - Number(isOverdue(a));
  if (overdueOrder !== 0) return overdueOrder;
  if (bucket === "awaitingReturn") {
    const aDue = a.return_date ?? "9999-12-31";
    const bDue = b.return_date ?? "9999-12-31";
    const dueOrder = aDue.localeCompare(bDue);
    if (dueOrder !== 0) return dueOrder;
  }
  const ageOrder = String(a.created_at ?? "").localeCompare(String(b.created_at ?? ""));
  return ageOrder || a.id.localeCompare(b.id);
}
