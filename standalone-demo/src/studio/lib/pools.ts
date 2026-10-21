// إحصائيات مجموعات الأصول — تجميع حالات الأصول إلى فئات عرض ثابتة.
// لا يكسر أي حالة غير معروفة: تُحسب في total فقط (وتُصنّف "other").

export type PoolStatGroup =
  | "available" | "reserved" | "maintenance" | "other";

// خريطة حالة الأصل الأساسية → فئة عرض. السجل المؤرشف لا يُعامل كحالة تشغيلية.
export function classifyStatus(status: string | null | undefined): PoolStatGroup {
  switch (status) {
    case "available": return "available";
    case "reserved": return "reserved";
    case "in_maintenance": return "maintenance";
    default: return "other"; // archived or unknown records count toward total only
  }
}

export interface PoolStats {
  total: number;
  available: number;
  reserved: number;
  maintenance: number;
  utilizationPct: number; // reserved / total × 100
}

export function computePoolStats(assets: { status?: string | null }[]): PoolStats {
  const s: PoolStats = {
    total: 0, available: 0, reserved: 0, maintenance: 0, utilizationPct: 0,
  };
  for (const a of assets) {
    s.total++; // total includes every linked asset, including archived records
    const g = classifyStatus(a.status);
    if (g !== "other") s[g]++;
  }
  const active = s.reserved;
  s.utilizationPct = s.total > 0 ? Math.round((active / s.total) * 100) : 0;
  return s;
}

// تجميع مصفوفة أصول (تحمل pool_id) حسب المجموعة → Map<pool_id, assets[]>
export function groupAssetsByPool<T extends { pool_id?: string | null }>(assets: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const a of assets) {
    if (!a.pool_id) continue;
    const arr = m.get(a.pool_id) ?? [];
    arr.push(a);
    m.set(a.pool_id, arr);
  }
  return m;
}
