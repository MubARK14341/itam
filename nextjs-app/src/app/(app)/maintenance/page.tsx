import { ReadSeed } from "@/components/providers/read-seed";
import type { PageSearchParams } from "@/lib/read-seeds/context";
import { maintenanceReadSeed } from "@/lib/read-seeds/operations";
import MaintenancePage from "./page-client";

export default async function Page({ searchParams }: { searchParams: PageSearchParams }) {
  const initialNowMs = Date.now();
  return (
    <>
      <ReadSeed seed={await maintenanceReadSeed(searchParams, initialNowMs)} />
      <MaintenancePage initialNowMs={initialNowMs} />
    </>
  );
}
