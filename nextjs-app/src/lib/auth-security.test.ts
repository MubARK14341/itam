import { describe, expect, it } from "vitest";
import {
  DEFAULT_ABSOLUTE_SECONDS,
  DEFAULT_IDLE_SECONDS,
  sessionExpiryAt,
} from "./auth-security";

describe("session security deadlines", () => {
  it("uses the earlier idle deadline", () => {
    expect(sessionExpiryAt({
      nowMs: 10_000,
      lastActivityMs: 5_000,
      signedInAtMs: 0,
      idleSeconds: 300,
      absoluteSeconds: 900,
    })).toBe(305_000);
  });

  it("never extends beyond the absolute session deadline", () => {
    expect(sessionExpiryAt({
      nowMs: 850_000,
      lastActivityMs: 850_000,
      signedInAtMs: 0,
      idleSeconds: 300,
      absoluteSeconds: 900,
    })).toBe(900_000);
  });

  it("has explicit conservative defaults", () => {
    expect(DEFAULT_IDLE_SECONDS).toBe(1800);
    expect(DEFAULT_ABSOLUTE_SECONDS).toBe(28800);
  });
});
