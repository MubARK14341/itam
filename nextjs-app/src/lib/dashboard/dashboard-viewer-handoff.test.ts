import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ context: vi.fn(), createClient: vi.fn(), staff: vi.fn(), redirect: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/read-seeds/context", () => ({ handedOffContext: mocks.context }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/auth-security", () => ({ getStaffAccessState: mocks.staff }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

import { resolveDashboardViewer } from "./get-command-center-data";

describe("dashboard verified request identity", () => {
  let auth: ReturnType<typeof vi.fn>;
  let rpc: ReturnType<typeof vi.fn>;
  let from: ReturnType<typeof vi.fn>;
  const session = { userId: "verified-user", email: "demo@example.invalid", role: "admin", approvalStatus: "approved", capabilities: ["report.export"], exposure: null };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.redirect.mockImplementation((path: string) => { throw new Error(`redirect:${path}`); });
    mocks.context.mockResolvedValue({ session });
    mocks.staff.mockResolvedValue({ role: "admin", approval_status: "approved", is_active: true });
    auth = vi.fn().mockResolvedValue({ data: { user: { id: "verified-user", email: session.email } }, error: null });
    rpc = vi.fn().mockResolvedValue({ data: ["report.export"], error: null });
    const query = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn().mockResolvedValue({ data: { full_name: "TEST Manager", email: session.email }, error: null }) };
    query.select.mockReturnValue(query); query.eq.mockReturnValue(query);
    from = vi.fn().mockReturnValue(query);
    mocks.createClient.mockResolvedValue({ auth: { getUser: auth }, rpc, from });
  });

  it("reuses only the current middleware identity and capabilities without additional security reads", async () => {
    const { viewer } = await resolveDashboardViewer();
    expect(viewer).toMatchObject({ id: session.userId, name: "TEST Manager", role: "admin", capabilities: ["report.export"] });
    expect(auth).not.toHaveBeenCalled();
    expect(mocks.staff).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    expect(from).toHaveBeenCalledExactlyOnceWith("app_users");
  });

  it("retains fresh Auth verification, active-state and capability reads without a handoff", async () => {
    mocks.context.mockResolvedValue(null);
    expect((await resolveDashboardViewer()).viewer.id).toBe(session.userId);
    expect(auth).toHaveBeenCalledOnce();
    expect(mocks.staff).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledExactlyOnceWith("my_capabilities");
  });

  it.each([
    ["employee", "/my-tasks"], ["technician", "/my-tasks"], ["warehouse_manager", "/my-tasks"],
    ["viewer", "/overview"], ["auditor", "/overview"], [null, "/pending-approval"],
  ])("keeps %s away from manager data using the existing redirect", async (role, path) => {
    mocks.context.mockResolvedValue({ session: { ...session, role } });
    await expect(resolveDashboardViewer()).rejects.toThrow(`redirect:${path}`);
    expect(from).not.toHaveBeenCalled();
  });

  it("rejects an unavailable verified user during fallback without reading a profile", async () => {
    mocks.context.mockResolvedValue(null);
    auth.mockResolvedValue({ data: { user: null }, error: null });
    await expect(resolveDashboardViewer()).rejects.toThrow("redirect:/login");
    expect(from).not.toHaveBeenCalled();
    expect(mocks.staff).not.toHaveBeenCalled();
  });

  it("rejects inactive staff during fallback before profile/widget reads", async () => {
    mocks.context.mockResolvedValue(null);
    mocks.staff.mockResolvedValue({ role: "admin", approval_status: "approved", is_active: false });
    await expect(resolveDashboardViewer()).rejects.toThrow("redirect:/pending-approval");
    expect(from).not.toHaveBeenCalled();
  });
});
