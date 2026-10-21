import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ session: vi.fn(), data: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth: { getSession: mocks.session } }) }));
vi.mock("@/lib/supabase/read-prefetch", () => ({ prefetchRouteData: mocks.data }));

import { prefetchIntentProps, prefetchWhenIdle } from "./route-prefetch";
import { SERVER_SEEDED_ROUTES } from "@/lib/read-seeds/routes";

describe("navigation warm-up work", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.stubGlobal("window", { location: { pathname: "/dashboard", href: "http://localhost/dashboard" },
      setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
    mocks.session.mockResolvedValue({ data: { session: { access_token: "TEST", user: { id: "TEST" } } } });
    mocks.data.mockResolvedValue(undefined);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("does not issue browser report or seeded-list reads during idle warming", async () => {
    const cleanup = prefetchWhenIdle(["/reports", "/assets", "/maintenance"]);
    await vi.advanceTimersByTimeAsync(1500);
    expect(mocks.session).not.toHaveBeenCalled();
    expect(mocks.data).not.toHaveBeenCalled();
    cleanup();
  });

  it("warms an expensive route's page only on explicit pointer/keyboard/touch intent", () => {
    const prefetchPage = vi.fn();
    const handlers = prefetchIntentProps("/reports", prefetchPage);
    expect(prefetchPage).not.toHaveBeenCalled();
    handlers.onFocus(); handlers.onPointerEnter(); handlers.onTouchStart();
    expect(prefetchPage).toHaveBeenCalledTimes(3);
    expect(prefetchPage).toHaveBeenCalledWith("/reports");
    expect(mocks.data).not.toHaveBeenCalled();
  });

  it("runs one idle destination at a time and cancels its current reads on navigation cleanup", async () => {
    let signal: AbortSignal | null = null;
    mocks.data.mockImplementation((_path: string, _auth: unknown, nextSignal: AbortSignal) => {
      signal = nextSignal;
      return new Promise((_, reject) => nextSignal.addEventListener("abort", () => reject(nextSignal.reason), { once: true }));
    });
    const cleanup = prefetchWhenIdle(["/purchase-requests", "/stocktakes"]);
    await vi.advanceTimersByTimeAsync(1500);
    expect(mocks.data).toHaveBeenCalledOnce();
    cleanup();
    await vi.runAllTimersAsync();
    expect((signal as unknown as AbortSignal).aborted).toBe(true);
    expect(mocks.data).toHaveBeenCalledOnce();
  });

  it.each([...SERVER_SEEDED_ROUTES])("keeps page intent warming for registered server-seeded %s", (href) => {
    const prefetchPage = vi.fn();
    const handlers = prefetchIntentProps(href, prefetchPage);
    handlers.onPointerEnter(); handlers.onFocus(); handlers.onTouchStart();
    expect(prefetchPage.mock.calls).toEqual([[href], [href], [href]]);
    expect(mocks.session).not.toHaveBeenCalled();
    expect(mocks.data).not.toHaveBeenCalled();
  });

  it.each(["/dashboard", "/overview", "/settings", "/scan", "/purchase-requests", "/stocktakes"])(
    "warms remembered data without a speculative full page for non-seeded %s", async (href) => {
      window.location.pathname = "/assets";
      window.location.href = "http://localhost/assets";
      const prefetchPage = vi.fn();
      const handlers = prefetchIntentProps(href, prefetchPage);
      handlers.onPointerEnter(); handlers.onFocus(); handlers.onTouchStart();
      await Promise.resolve();
      expect(prefetchPage).not.toHaveBeenCalled();
      expect(mocks.session).toHaveBeenCalledTimes(3);
      expect(mocks.data).toHaveBeenCalledTimes(3);
      expect(mocks.data.mock.calls.every(([pathname]) => pathname === href)).toBe(true);
    },
  );

  it("chooses seeded warming by pathname while preserving its complete destination", () => {
    const href = "/reports?tab=inventory#financial-data-quality";
    const prefetchPage = vi.fn();
    prefetchIntentProps(href, prefetchPage).onFocus();
    expect(prefetchPage).toHaveBeenCalledWith(href);
    expect(mocks.session).not.toHaveBeenCalled();
    expect(mocks.data).not.toHaveBeenCalled();
  });

  it("keeps non-seeded query and fragment navigation on the remembered-data path", async () => {
    window.location.pathname = "/assets";
    window.location.href = "http://localhost/assets";
    const prefetchPage = vi.fn();
    prefetchIntentProps("/dashboard?view=operational#summary", prefetchPage).onFocus();
    await Promise.resolve();
    expect(prefetchPage).not.toHaveBeenCalled();
    expect(mocks.data).toHaveBeenCalledOnce();
    expect(mocks.data.mock.calls[0][0]).toBe("/dashboard");
  });

  it("does not start either kind of browser warming without a browser window", () => {
    vi.stubGlobal("window", undefined);
    const prefetchPage = vi.fn();
    prefetchIntentProps("/assets", prefetchPage).onFocus();
    expect(prefetchPage).not.toHaveBeenCalled();
    expect(mocks.session).not.toHaveBeenCalled();
    expect(mocks.data).not.toHaveBeenCalled();
  });
});
