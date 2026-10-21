"use client";

import { Suspense, useEffect, useState } from "react";
import { ScanConsole } from "@/components/scan/scan-console";
import { ScanHistory } from "@/components/scan/scan-history";
import { PageHeader } from "@/components/ui/page-header";
import { Spinner } from "@/components/ui/spinner";
import { getFormOptions } from "@/lib/queries";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { useSession, canUseScan } from "@/lib/session";
import { useFeatureExposure } from "@/components/providers/feature-exposure-provider";
import { FeatureRoute } from "@/components/feature-gate";

export default function ScanPage() {
  const { t } = useAppPreferences();
  const { role } = useSession();
  const { isVisible } = useFeatureExposure();
  const ops = canUseScan(role);
  // إظهار تدريجي: سجل المسح من مستوى 40 (فوق شرط الدور ops، لا بديلًا عنه — RLS يحجب غيرهم أصلًا).
  const historyVisible = isVisible("scan.history");
  const [opts, setOpts] = useState<{ employees: any[]; departments: any[]; locations: any[]; warehouseId: string | null }>({
    employees: [], departments: [], locations: [], warehouseId: null,
  });
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    (async () => {
      const o = await getFormOptions();
      const wh = (o.locations ?? []).find((l: any) => l.code === "WH") ?? null;
      setOpts({ employees: o.employees ?? [], departments: o.departments ?? [], locations: o.locations ?? [], warehouseId: wh?.id ?? null });
    })();
  }, []);

  return (
    <FeatureRoute feature="scan.search">
    <div>
      <PageHeader title={t.scan.title} description={t.scan.subtitle} />

      {/* السجل يُعرض أسفل الماسح ونتيجة المسح بعرض كامل — للأدوار التشغيلية فقط (RLS يحجب غيرهم أصلًا).
          Suspense مطلوب لقراءة ?q= (بحث الشريط العلوي) عبر useSearchParams داخل ScanConsole. */}
      <Suspense fallback={<div className="flex justify-center py-16"><Spinner label={t.common.loading} /></div>}>
        <ScanConsole
          employees={opts.employees}
          departments={opts.departments}
          warehouseId={opts.warehouseId}
          locations={opts.locations}
          onLogged={() => setRefreshKey((k) => k + 1)}
          historySlot={ops && historyVisible ? <ScanHistory refreshKey={refreshKey} /> : null}
        />
      </Suspense>
    </div>
    </FeatureRoute>
  );
}
