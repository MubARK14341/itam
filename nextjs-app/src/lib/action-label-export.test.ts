import { describe, it, expect, vi, beforeEach } from "vitest";
const { rpc, failure } = vi.hoisted(() => ({ rpc: vi.fn(), failure: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ rpc }) }));
vi.mock("@/lib/observability", () => ({ reportOperationalFailure: failure }));
import { resolveUserLabels } from "./action-center";

describe("export assignee labels", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it("rejects a failed identity lookup for complete exports instead of silently blanking names", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "TEST label lookup failed" } });
    await expect(resolveUserLabels(["owned-user"], { requireComplete: true })).rejects.toThrow("TEST label lookup failed");
    expect(failure).toHaveBeenCalledOnce();
  });
  it("retains the existing optional-label behavior for ordinary list rendering", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "TEST label lookup failed" } });
    expect(await resolveUserLabels(["owned-user"])).toEqual(new Map());
  });
});
