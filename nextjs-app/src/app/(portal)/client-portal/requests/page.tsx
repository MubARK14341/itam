import { ReadSeed } from "@/components/providers/read-seed";
import { portalRequestsReadSeed } from "@/lib/read-seeds/portal";
import PortalRequestsPage from "./page-client";

export default async function Page() {
  return (
    <>
      <ReadSeed seed={await portalRequestsReadSeed()} />
      <PortalRequestsPage />
    </>
  );
}
