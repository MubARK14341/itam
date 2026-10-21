import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const middleware = readFileSync(new URL("./supabase/middleware.ts", import.meta.url), "utf8");

describe("portal internal-route guard", () => {
  it("redirects a portal identity before any internal app shell can render", () => {
    expect(middleware).toContain('security.subject_kind === "portal"');
    expect(middleware).toContain('!request.nextUrl.pathname.startsWith("/client-portal")');
    expect(middleware).toContain('url.pathname = "/client-portal"');
  });
});
