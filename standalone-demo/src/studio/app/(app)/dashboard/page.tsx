import { DashboardCommandCenter } from "@/components/dashboard-v6/dashboard-command-center";
import { getDashboardCommandCenterData } from "@/lib/dashboard/get-command-center-data";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const data = await getDashboardCommandCenterData();
  return <DashboardCommandCenter data={data} />;
}
