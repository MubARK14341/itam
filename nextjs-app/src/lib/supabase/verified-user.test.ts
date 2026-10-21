import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthApiError, AuthRetryableFetchError, AuthSessionMissingError, type User, type UserResponse } from "@supabase/supabase-js";
import { getVerifiedUser } from "./verified-user";

const user: User = { id: "verified-user", aud: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-10-09T00:00:00Z" };
const success: UserResponse = { data: { user }, error: null };
const failure = (error: AuthRetryableFetchError | AuthApiError | AuthSessionMissingError): UserResponse => ({ data: { user: null }, error });

describe("bounded Auth verification", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("returns a verified user without extra network reads", async () => {
    const read = vi.fn<() => Promise<UserResponse>>().mockResolvedValue(success);
    await expect(getVerifiedUser(read)).resolves.toEqual(success);
    expect(read).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, 500, 503])("recovers only after Auth verifies the user following transport status%s", async (status) => {
    const read = vi.fn<() => Promise<UserResponse>>()
      .mockResolvedValueOnce(failure(new AuthRetryableFetchError("TEST transport failure", status)))
      .mockResolvedValueOnce(success);
    const result = getVerifiedUser(read);
    await vi.advanceTimersByTimeAsync(99);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual(success);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("stops after three failed transport reads with no cached identity", async () => {
    const denied = failure(new AuthRetryableFetchError("TEST unavailable", 503));
    const read = vi.fn<() => Promise<UserResponse>>().mockResolvedValue(denied);
    const result = getVerifiedUser(read);
    await vi.runAllTimersAsync();
    await expect(result).resolves.toEqual(denied);
    expect(read).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([400, 401, 403])("does not retry an Auth denial status%s", async (status) => {
    const denied = failure(new AuthApiError("TEST rejected", status, "invalid_jwt"));
    const read = vi.fn<() => Promise<UserResponse>>().mockResolvedValue(denied);
    await expect(getVerifiedUser(read)).resolves.toEqual(denied);
    expect(read).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not retry a missing session", async () => {
    const denied = failure(new AuthSessionMissingError());
    const read = vi.fn<() => Promise<UserResponse>>().mockResolvedValue(denied);
    await expect(getVerifiedUser(read)).resolves.toEqual(denied);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("does not retry a wrongly classified 4xx transport error", async () => {
    const denied = failure(new AuthRetryableFetchError("TEST rejected", 403));
    const read = vi.fn<() => Promise<UserResponse>>().mockResolvedValue(denied);
    await expect(getVerifiedUser(read)).resolves.toEqual(denied);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("stops immediately if the retry reveals a revoked session", async () => {
    const denied = failure(new AuthApiError("TEST revoked", 401, "session_not_found"));
    const read = vi.fn<() => Promise<UserResponse>>()
      .mockResolvedValueOnce(failure(new AuthRetryableFetchError("TEST network", 0)))
      .mockResolvedValueOnce(denied);
    const result = getVerifiedUser(read);
    await vi.runAllTimersAsync();
    await expect(result).resolves.toEqual(denied);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("propagates unexpected programming errors instead of treating them as a session", async () => {
    const read = vi.fn<() => Promise<UserResponse>>().mockRejectedValue(new TypeError("TEST unexpected"));
    await expect(getVerifiedUser(read)).rejects.toThrow(TypeError);
    expect(read).toHaveBeenCalledTimes(1);
  });
});
