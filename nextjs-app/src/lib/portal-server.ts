import "server-only";
import { createClient } from "@/lib/supabase/server";
import { parsePortalContext, type PortalContext } from "@/lib/portal";

/** Read the portal context next to the database so the portal shell renders without a browser round trip. */
export async function getInitialPortalContext(): Promise<PortalContext | null> {
  try {
    const sb = await createClient();
    const { data } = await sb.rpc("portal_get_context");
    return parsePortalContext(data);
  } catch {
    return null;
  }
}
