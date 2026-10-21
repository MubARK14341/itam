import "server-only";

// Server read seeds for the customer portal; each mirrors the first load of its page-client.tsx.

import {
  portalGetProfile,
  portalGetRequestDashboard,
  portalListCatalog,
  portalListConsumables,
  portalListRequests,
} from "@/lib/portal";
import { collectReadSeed } from "@/lib/supabase/server-read-seed";
import { handedOffContext } from "@/lib/read-seeds/context";

async function portalRole() {
  return (await handedOffContext())?.portal?.portal_role ?? null;
}

export async function portalHomeReadSeed() {
  if (!await portalRole()) return null;
  return collectReadSeed(() => portalGetRequestDashboard());
}

export async function portalRequestsReadSeed() {
  if (!await portalRole()) return null;
  return collectReadSeed(() => portalListRequests());
}

export async function portalProfileReadSeed() {
  if (!await portalRole()) return null;
  return collectReadSeed(() => portalGetProfile());
}

export async function portalNewRequestReadSeed() {
  const role = await portalRole();
  // Viewers are sent back to the request list before this page loads anything.
  if (!role || role === "viewer") return null;
  return collectReadSeed(() => Promise.all([portalGetProfile(), portalListCatalog(), portalListConsumables()]));
}
