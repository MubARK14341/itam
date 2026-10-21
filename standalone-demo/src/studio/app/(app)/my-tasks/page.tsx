import { ReadSeed } from "@/components/providers/read-seed";
import { myTasksReadSeed } from "@/lib/read-seeds/self-service";
import MyTasksPage from "./page-client";

export default async function Page() {
  return (
    <>
      <ReadSeed seed={await myTasksReadSeed()} />
      <MyTasksPage />
    </>
  );
}
