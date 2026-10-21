import { ReadSeed } from "@/components/providers/read-seed";
import { activityReadSeed } from "@/lib/read-seeds/operations";
import ActivityPage from "./page-client";

export default async function Page() {
  return (
    <>
      <ReadSeed seed={await activityReadSeed()} />
      <ActivityPage />
    </>
  );
}
