import { ReadSeed } from "@/components/providers/read-seed";
import { portalNewRequestReadSeed } from "@/lib/read-seeds/portal";
import PortalNewRequestPage from "./page-client";

export default async function Page() {
  return (
    <>
      <ReadSeed seed={await portalNewRequestReadSeed()} />
      <PortalNewRequestPage />
    </>
  );
}
