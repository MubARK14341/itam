import { describe, expect, it } from "vitest";
import { isPublicPath } from "./public-routes";

describe("public routes", () => {
  it.each([
    "/login",
    "/register",
    "/a/public-token",
    "/client-portal-register",
    "/api/health/schema",
    "/api/csp-report",
    "/robots.txt",
  ])("allows %s without a session", (pathname) => {
    expect(isPublicPath(pathname)).toBe(true);
  });

  it.each([
    "/",
    "/login-copy",
    "/api/health",
    "/api/csp-reporting",
    "/robots.txt/private",
    "/dashboard",
  ])("keeps %s protected", (pathname) => {
    expect(isPublicPath(pathname)).toBe(false);
  });
});
