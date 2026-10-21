import { InitialPortalContextProvider } from "@/components/providers/portal-initial";
import { headers } from "next/headers";
import { getInitialPortalContext } from "@/lib/portal-server";
import { decodeInitialContext, INITIAL_CONTEXT_HEADER } from "@/lib/initial-context-header";

export default async function PortalGroupLayout({ children }: { children: React.ReactNode }) {
  // Resolved next to the database; the client portal layout falls back to its own read when null.
  const handedOff = decodeInitialContext((await headers()).get(INITIAL_CONTEXT_HEADER))?.portal;
  const initialContext = handedOff ?? await getInitialPortalContext();
  return <InitialPortalContextProvider value={initialContext}>{children}</InitialPortalContextProvider>;
}
