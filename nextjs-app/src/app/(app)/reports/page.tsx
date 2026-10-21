import { ReadSeed } from "@/components/providers/read-seed";
import { reportsReadSeed } from "@/lib/read-seeds/operations";
import { handedOffContext, type PageSearchParams } from "@/lib/read-seeds/context";
import { isFeatureVisible } from "@/lib/feature-exposure";
import { resolveEffectiveLevel } from "@/lib/feature-exposure-settings";
import { resolveReportTab, visibleReportTabs } from "@/lib/report-load-plan";
import ReportsPage from "./page-client";

export default async function Page({ searchParams }: { searchParams: PageSearchParams }) {
  const [params, context] = await Promise.all([searchParams, handedOffContext()]);
  const session = context?.session;
  const visible = session ? visibleReportTabs(
    (feature) => isFeatureVisible(feature, session.role, { level: resolveEffectiveLevel(session.role, session.exposure) }),
    session.capabilities.includes("report.customer_requests"),
  ) : [];
  const initialTab = resolveReportTab(typeof params.tab === "string" ? params.tab : null, visible);
  return (
    <>
      <ReadSeed seed={await reportsReadSeed(initialTab)} />
      <ReportsPage initialTab={initialTab} />
    </>
  );
}
