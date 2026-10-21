export type InventoryListType = "all" | "assets" | "consumables";

export type InventoryListState = {
  q?: string;
  category?: string;
  status?: string;
  location?: string;
  company?: string;
  type?: InventoryListType;
};

/** Builds a stable in-app return target without carrying unrelated URL state. */
export function buildInventoryReturnTo(state: InventoryListState): string {
  const params = new URLSearchParams();
  if (state.q?.trim()) params.set("q", state.q.trim());
  if (state.category) params.set("cat", state.category);
  if (state.status) params.set("status", state.status);
  if (state.location) params.set("loc", state.location);
  if (state.company) params.set("company", state.company);
  if (state.type && state.type !== "all") params.set("type", state.type);
  const query = params.toString();
  return query ? `/assets?${query}` : "/assets";
}

export function withInventoryReturnTo(href: string, returnTo: string): string {
  const separator = href.includes("?") ? "&" : "?";
  return `${href}${separator}returnTo=${encodeURIComponent(returnTo)}`;
}

/** Allows only the inventory list itself as a return target. */
export function safeInventoryReturnTo(value: string | null | undefined): string {
  if (!value?.startsWith("/assets")) return "/assets";
  try {
    const parsed = new URL(value, "https://itam.invalid");
    if (parsed.origin !== "https://itam.invalid" || parsed.pathname !== "/assets") return "/assets";
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return "/assets";
  }
}
