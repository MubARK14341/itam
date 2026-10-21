import { isAuthRetryableFetchError, type UserResponse } from "@supabase/supabase-js";

/** Verify with Auth; transient transport failures never become a trusted cookie identity. */
export async function getVerifiedUser(readUser: () => Promise<UserResponse>): Promise<UserResponse> {
  for (let attempt = 0; ; attempt += 1) {
    const result = await readUser();
    const error = result.error;
    const transient = isAuthRetryableFetchError(error)
      && (error.status === 0 || (error.status != null && error.status >= 500 && error.status < 600));
    if (!transient || attempt >= 2) return result;
    // At most three read-only Auth calls, with a short backoff between them.
    await new Promise<void>((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
  }
}
