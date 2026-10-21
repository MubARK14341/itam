import { ReadSeed } from "@/components/providers/read-seed";
import { myRequestsReadSeed } from "@/lib/read-seeds/self-service";
import MyRequestsPage from "./page-client";

export default async function Page() {
  return (
    <>
      <ReadSeed seed={await myRequestsReadSeed()} />
      <MyRequestsPage />
    </>
  );
}
