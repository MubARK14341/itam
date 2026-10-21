import { ReadSeed } from "@/components/providers/read-seed";
import { portalHomeReadSeed } from "@/lib/read-seeds/portal";
import ClientPortalHome from "./page-client";

export default async function Page() {
  return (
    <>
      <ReadSeed seed={await portalHomeReadSeed()} />
      <ClientPortalHome />
    </>
  );
}
