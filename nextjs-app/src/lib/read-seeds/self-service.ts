import "server-only";

// Server read seeds for the employee pages; each mirrors the first load of its page-client.tsx.

import {
  listMyEmployeeAssets,
  listMyEmployeeRequests,
  listMyEmployeeReturnRequests,
  listWarehouseEmployeeReturnQueue,
} from "@/lib/employee-self-service";
import { listRequests } from "@/lib/requests";
import { collectReadSeed } from "@/lib/supabase/server-read-seed";
import { handedOffContext } from "@/lib/read-seeds/context";

async function staffRole() {
  return (await handedOffContext())?.session?.role ?? null;
}

export async function myTasksReadSeed() {
  const role = await staffRole();
  if (role === "employee") {
    return collectReadSeed(() => Promise.all([
      listMyEmployeeRequests(), listMyEmployeeAssets(), listMyEmployeeReturnRequests(),
    ]));
  }
  if (role === "technician" || role === "warehouse_manager") {
    return collectReadSeed(() => Promise.all([
      listRequests({ includeFinancial: false }),
      listWarehouseEmployeeReturnQueue(),
    ]));
  }
  return null;
}

export async function myRequestsReadSeed() {
  if (await staffRole() !== "employee") return null;
  return collectReadSeed(() => listMyEmployeeRequests());
}

export async function myAssetsReadSeed() {
  if (await staffRole() !== "employee") return null;
  return collectReadSeed(() => Promise.all([listMyEmployeeAssets(), listMyEmployeeReturnRequests()]));
}
