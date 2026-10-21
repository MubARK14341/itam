import type { SupabaseClient } from "@supabase/supabase-js";

// These two functions are STABLE, read-only routing checks. Never retry an arbitrary
// POST/RPC: operational writes may already have committed when a socket disconnects.
type AuthRoutingRpc = "auth_security_state" | "app_user_role";
const CONNECTION_CODES = new Set(["PGRST000", "PGRST001", "PGRST002", "PGRST003", "53300", "57P01", "57P02", "57P03", "08000", "08001", "08003", "08006"]);

export async function readAuthRoutingRpc(client: SupabaseClient, name: AuthRoutingRpc) {
  for (let attempt = 0; ; attempt += 1) {
    const result = name === "auth_security_state"
      ? await client.rpc("auth_security_state")
      : await client.rpc("app_user_role");
    const error = result.error;
    // PostgREST's SDK represents fetch rejection as status 0, without a SQL code.
    // Abort, malformed JSON and header-overflow errors are not connection retries.
    const transport = result.status === 0 && error?.code === ""
      && /^(?:TypeError: (?:fetch failed|Failed to fetch|NetworkError)|FetchError:)/.test(error.message)
      && !/abort|headers exceeded/i.test(error.hint);
    const unavailable = result.status >= 500 && result.status < 600 && error
      && (!error.code || CONNECTION_CODES.has(error.code));
    if ((!transport && !unavailable) || attempt >= 2) return result;
    await new Promise<void>((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
  }
}
