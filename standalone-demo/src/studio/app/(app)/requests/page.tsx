import { ReadSeed } from "@/components/providers/read-seed";
import type { PageSearchParams } from "@/lib/read-seeds/context";
import { requestsReadSeed } from "@/lib/read-seeds/operations";
import RequestsPage from "./page-client";

export default async function Page({ searchParams }: { searchParams: PageSearchParams }) {
  return (
    <>
      <ReadSeed seed={await requestsReadSeed(searchParams)} />
      <RequestsPage />
    </>
  );
}
