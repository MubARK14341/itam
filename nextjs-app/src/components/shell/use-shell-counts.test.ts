import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ actions: vi.fn(), requests: vi.fn() }));
vi.mock("@/lib/action-center", () => ({ getActionAlertOperationalCounts: mocks.actions }));
vi.mock("@/lib/requests", () => ({ getRequestOperationalCounts: mocks.requests }));
vi.mock("@/lib/session", () => ({ useSession: () => ({ userId: "TEST" }) }));

import { invalidateShellCounts, loadShellCounts } from "./use-shell-counts";
import { clearReadPrefetch, subscribeReadInvalidation } from "@/lib/supabase/read-prefetch";

describe("shell count cache boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateShellCounts();
    mocks.actions.mockResolvedValue({ counts: { needs_action: 3 } });
    mocks.requests.mockResolvedValue({ counts: { review: 2, overdue: 1 } });
  });

  it("shares a single read for the same user and visible badge set", async () => {
    const first = loadShellCounts("actor-a", true, true);
    const second = loadShellCounts("actor-a", true, true);
    expect(first).toBe(second);
    expect(await first).toEqual({ actions: 3, requests: 3 });
    expect(mocks.actions).toHaveBeenCalledOnce();
    expect(mocks.requests).toHaveBeenCalledOnce();
  });

  it("never hands another user's cached counts to the next identity", async () => {
    await loadShellCounts("actor-a", true, true);
    mocks.actions.mockResolvedValue({ counts: { needs_action: 8 } });
    expect((await loadShellCounts("actor-b", true, true)).actions).toBe(8);
    expect(mocks.actions).toHaveBeenCalledTimes(2);
  });

  it("reloads after the read invalidation boundary used by writes and sign-out", async () => {
    const unsubscribe = subscribeReadInvalidation(invalidateShellCounts);
    try {
      await loadShellCounts("actor-a", true, true);
      mocks.requests.mockResolvedValue({ counts: { review: 5, overdue: 2 } });
      clearReadPrefetch();
      expect((await loadShellCounts("actor-a", true, true)).requests).toBe(7);
      expect(mocks.requests).toHaveBeenCalledTimes(2);
    } finally { unsubscribe(); }
  });

  it("hides decorations when their reads are denied or unavailable", async () => {
    mocks.actions.mockRejectedValue(new Error("TEST denied"));
    mocks.requests.mockResolvedValue({ counts: null });
    expect(await loadShellCounts("actor-a", true, true)).toEqual({ actions: null, requests: null });
  });
});
