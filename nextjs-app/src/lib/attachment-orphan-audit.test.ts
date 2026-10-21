import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = resolve(
  process.cwd(),
  "scripts/audit/attachment-orphans.mjs",
);
const source = readFileSync(scriptPath, "utf8");

describe("attachment orphan inventory safety contract", () => {
  it("offers read-only help without credentials", () => {
    const output = execFileSync(process.execPath, [scriptPath, "--help"], {
      encoding: "utf8",
    });
    expect(output).toContain("Read-only attachment orphan inventory");
    expect(output).toContain("has no delete mode");
  });

  it("contains no Storage or metadata mutation call", () => {
    for (const mutation of [
      ".remove(",
      ".delete(",
      ".insert(",
      ".update(",
      ".upsert(",
      ".upload(",
    ]) {
      expect(source).not.toContain(mutation);
    }
    expect(source).toContain('mode: "read_only_dry_run"');
    expect(source).toContain("assertApprovedOrLocalSupabaseTarget");
    expect(source).not.toContain("ATTACHMENT_AUDIT_ALLOW_PRODUCTION_READ");
  });
});
