import { ReadSeed } from "@/components/providers/read-seed";
import { alertsReadSeed } from "@/lib/read-seeds/operations";
import ActionCenterPage from "./page-client";

export default async function Page() {
  return (
    <>
      <ReadSeed seed={await alertsReadSeed()} />
      <ActionCenterPage />
    </>
  );
}
