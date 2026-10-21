import "server-only";

import { cache } from "react";
import { headers } from "next/headers";
import { decodeInitialContext, INITIAL_CONTEXT_HEADER } from "@/lib/initial-context-header";

/** The identity the middleware verified for this request (UI hydration only; RLS still decides). */
export const handedOffContext = cache(async () =>
  decodeInitialContext((await headers()).get(INITIAL_CONTEXT_HEADER)));

export type PageSearchParams = Promise<Record<string, string | string[] | undefined>>;

/** The page's query string as `window.location.search` would show it. */
export async function searchString(searchParams: PageSearchParams): Promise<string> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    if (Array.isArray(value)) value.forEach((item) => params.append(key, item));
    else if (value != null) params.append(key, value);
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}
