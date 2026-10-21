import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SERVER_SEEDED_ROUTES } from "./routes";

const app = resolve(import.meta.dirname, "../../app");
const pageFile = (route: string) => route.startsWith("/client-portal")
  ? resolve(app, "(portal)", `.${route}`, "page.tsx")
  : resolve(app, "(app)", `.${route}`, "page.tsx");

describe("server read seed routes", () => {
  it("lists exactly the pages that render a ReadSeed before their client page", () => {
    for (const route of SERVER_SEEDED_ROUTES) {
      const file = pageFile(route);
      expect(existsSync(file), route).toBe(true);
      const source = readFileSync(file, "utf8");
      expect(source, route).not.toContain('"use client"');
      const seedAt = source.indexOf("<ReadSeed seed=");
      const pageAt = source.indexOf("<", seedAt + 1);
      expect(seedAt, route).toBeGreaterThan(-1);
      expect(pageAt, route).toBeGreaterThan(seedAt);
      expect(source, route).toContain('from "./page-client"');
    }
  });
});
