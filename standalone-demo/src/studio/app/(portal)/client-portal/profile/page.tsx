import { ReadSeed } from "@/components/providers/read-seed";
import { portalProfileReadSeed } from "@/lib/read-seeds/portal";
import PortalProfilePage from "./page-client";

export default async function Page() {
  return (
    <>
      <ReadSeed seed={await portalProfileReadSeed()} />
      <PortalProfilePage />
    </>
  );
}
