/** Keep Auth verification retries independent of Next's render GET deduplication. */
export function authUserFetch(fetcher: typeof fetch = fetch): typeof fetch {
  return (input, init) => {
    const address = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (method.toUpperCase() !== "GET" || new URL(address).pathname !== "/auth/v1/user") {
      return fetcher(input, init);
    }
    // Next treats an explicit signal as a request-owned read, outside its render
    // dedupe cache. Preserve a caller's cancellation; only supply a fresh signal
    // when the Auth SDK has none. No write or other data-fetch options change.
    const signal = init?.signal ?? (input instanceof Request ? input.signal : new AbortController().signal);
    return fetcher(input, { ...init, signal });
  };
}
