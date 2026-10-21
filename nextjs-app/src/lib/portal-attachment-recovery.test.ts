import { beforeEach, describe, expect, it, vi } from "vitest";
import { uploadRequestAttachmentPortal } from "./request-attachments";

const mocks = vi.hoisted(() => ({ session: vi.fn(), upload: vi.fn(), remove: vi.fn(), rpc: vi.fn(), header: vi.fn(), validate: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({
  auth: { getSession: mocks.session },
  storage: { from: () => ({ upload: mocks.upload, remove: mocks.remove }) },
  rpc: (name: string, params: unknown) => {
    const result = Promise.resolve(mocks.rpc(name, params));
    return Object.assign(result, { setHeader: (key: string, value: string) => { mocks.header(key, value); return result; } });
  },
}) }));
vi.mock("@/lib/attachment-files", async (importOriginal) => ({
  ...await importOriginal<typeof import("./attachment-files")>(), validateAttachmentContent: mocks.validate,
}));

const actor = "11111111-1111-4111-8111-111111111111", other = "22222222-2222-4222-8222-222222222222";
const id = "33333333-3333-4333-8333-333333333333";
const session = (actorId = actor) => ({ data: { session: { user: { id: actorId }, access_token: "TEST RAM-only attachment token" } }, error: null });
const file = () => new File(["%PDF-1.7\nTEST\n%%EOF"], "TEST-recovery.pdf", { type: "application/pdf" });
const lost = { data: null, error: { message: "TEST lost reply" } };

describe("portal attachment recovery", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.session.mockResolvedValue(session());
    mocks.validate.mockResolvedValue(null);
    mocks.upload.mockResolvedValue({ error: null });
    mocks.rpc.mockResolvedValue({ data: { ok: true, id: "TEST attachment" }, error: null });
  });

  it("reconciles a committed registration with the exact same path, without a second upload or cleanup", async () => {
    const attachment = file();
    mocks.rpc.mockResolvedValueOnce(lost).mockResolvedValueOnce({ data: { ok: true, registered: true }, error: null });
    expect(await uploadRequestAttachmentPortal(id, attachment, actor)).toBe("TEST lost reply");
    expect(await uploadRequestAttachmentPortal(id, attachment, actor)).toBeNull();
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    expect(mocks.rpc.mock.calls[0][1]).toEqual(mocks.rpc.mock.calls[1][1]);
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.header).toHaveBeenCalledWith("Authorization", "Bearer TEST RAM-only attachment token");
    expect(mocks.upload.mock.calls[0][2]).toMatchObject({ upsert: false, headers: { Authorization: "Bearer TEST RAM-only attachment token" } });
  });

  it("reconciles a lost upload response before attempting another upload", async () => {
    const attachment = file();
    mocks.upload.mockResolvedValueOnce({ error: { message: "TEST lost upload reply" } });
    expect(await uploadRequestAttachmentPortal(id, attachment, actor)).toBe("upload_failed");
    expect(await uploadRequestAttachmentPortal(id, attachment, actor)).toBeNull();
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect(mocks.rpc.mock.calls[0][1].p_storage_path).toBe(mocks.upload.mock.calls[0][0]);
  });

  it("reuploads the same path only when the server confirms the object is absent", async () => {
    const attachment = file();
    mocks.upload.mockResolvedValueOnce({ error: { message: "TEST upload unavailable" } });
    await uploadRequestAttachmentPortal(id, attachment, actor);
    mocks.rpc.mockResolvedValueOnce({ data: { ok: false, error: "object_not_found" }, error: null })
      .mockResolvedValueOnce({ data: { ok: true }, error: null });
    expect(await uploadRequestAttachmentPortal(id, attachment, actor)).toBeNull();
    expect(mocks.upload).toHaveBeenCalledTimes(2);
    expect(mocks.upload.mock.calls[1][0]).toBe(mocks.upload.mock.calls[0][0]);
  });

  it("does not accept an already_registered mismatch as a successful replay", async () => {
    const attachment = file();
    mocks.rpc.mockResolvedValue({ data: { ok: false, error: "already_registered" }, error: null });
    expect(await uploadRequestAttachmentPortal(id, attachment, actor)).toBe("already_registered");
    expect(await uploadRequestAttachmentPortal(id, attachment, actor)).toBe("already_registered");
    expect(mocks.upload).toHaveBeenCalledTimes(1);
  });

  it("rejects a different current actor before touching a file or writing", async () => {
    mocks.session.mockResolvedValue(session(other));
    expect(await uploadRequestAttachmentPortal(id, file(), actor)).toBe("operation_actor_changed");
    expect(mocks.validate).not.toHaveBeenCalled(); expect(mocks.upload).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("stops before uploading when the actor changes during file validation", async () => {
    mocks.validate.mockImplementation(async () => { mocks.session.mockResolvedValue(session(other)); return null; });
    expect(await uploadRequestAttachmentPortal(id, file(), actor)).toBe("operation_actor_changed");
    expect(mocks.upload).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("stops registration when the actor changes while uploading, with the dispatched upload pinned to its owner", async () => {
    mocks.upload.mockImplementation(async () => { mocks.session.mockResolvedValue(session(other)); return { error: null }; });
    expect(await uploadRequestAttachmentPortal(id, file(), actor)).toBe("operation_actor_changed");
    expect(mocks.upload.mock.calls[0][2].headers.Authorization).toBe("Bearer TEST RAM-only attachment token");
    expect(mocks.rpc).not.toHaveBeenCalled(); expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("retains an uncertain registration for its owner and never retries it as another actor", async () => {
    const attachment = file();
    mocks.rpc.mockImplementationOnce(async () => { mocks.session.mockResolvedValue(session(other)); return { data: { ok: true }, error: null }; });
    expect(await uploadRequestAttachmentPortal(id, attachment, actor)).toBe("operation_actor_changed");
    expect(await uploadRequestAttachmentPortal(id, attachment, actor)).toBe("operation_actor_changed");
    expect(mocks.rpc).toHaveBeenCalledTimes(1); expect(mocks.upload).toHaveBeenCalledTimes(1);
    mocks.session.mockResolvedValue(session());
    expect(await uploadRequestAttachmentPortal(id, attachment, actor)).toBeNull();
    expect(mocks.rpc.mock.calls[1][1]).toEqual(mocks.rpc.mock.calls[0][1]);
    expect(mocks.upload).toHaveBeenCalledTimes(1);
  });
});
