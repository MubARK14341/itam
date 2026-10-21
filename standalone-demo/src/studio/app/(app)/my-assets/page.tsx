import { ReadSeed } from "@/components/providers/read-seed";
import { myAssetsReadSeed } from "@/lib/read-seeds/self-service";
import MyAssetsPage from "./page-client";

export default async function Page() {
  return (
    <>
      <ReadSeed seed={await myAssetsReadSeed()} />
      <MyAssetsPage />
    </>
  );
}
