import {execFileSync} from "node:child_process";
import { createHash } from "node:crypto";
import {
  readFileSync,
  readdirSync,
} from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const manifest = JSON.parse(
  readFileSync(
    resolve(root, "docs/audit-remediation/MIGRATION_MANIFEST.json"),
    "utf8",
  ),
) as {
  manifestDigest: string;
  ordered: Array<{
    order: number;
    id: string;
    path: string;
    executionMode: string;
    dependsOn: string[];
    sha256: string;
  }>;
  absorbed: Array<{ path: string; executionMode: string; sha256: string }>;
  productionOnly: Array<{ path: string; executionMode: string; sha256: string }>;
};
const packageJson = JSON.parse(
  readFileSync(resolve(root, "package.json"), "utf8"),
) as { scripts: Record<string, string> };
const rebuild = readFileSync(
  resolve(root, "scripts/test/rebuild-supabase-e2e.mjs"),
  "utf8",
);
const restore = readFileSync(
  resolve(root, "scripts/test/rehearse-local-restore.mjs"),
  "utf8",
);

function digest(path: string) {
  return createHash("sha256")
    .update(readFileSync(resolve(root, path)))
    .digest("hex");
}

describe("migration and local restore contracts", () => {
  it("classifies every top-level migration exactly once with a valid checksum", () => {
    const migrationPaths = readdirSync(resolve(root, "migrations"))
      .filter((name) => /^\d{14}_.+\.sql$/.test(name))
      .map((name) => `migrations/${name}`)
      .sort();
    const entries = [
      ...manifest.ordered.filter((entry) =>
        /^migrations\/\d{14}_.+\.sql$/.test(entry.path)
      ),
      ...manifest.absorbed,
      ...manifest.productionOnly,
    ];
    const classifiedPaths = entries.map((entry) => entry.path).sort();

    expect(classifiedPaths).toEqual(migrationPaths);
    expect(new Set(classifiedPaths).size).toBe(classifiedPaths.length);
    for (const entry of entries) {
      expect(entry.sha256).toBe(digest(entry.path));
    }
  });

  it("defines one strict rebuild order and isolates production scheduling", () => {
    expect(manifest.manifestDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.ordered.map((entry) => entry.order)).toEqual(
      manifest.ordered.map((_, index) => index + 1),
    );
    expect(manifest.ordered[0].id).toBe("baseline_20260707");
    expect(manifest.ordered.at(-1)?.id).toBe(
      "bootstrap_operational_assets_grants",
    );
    expect(
      manifest.productionOnly.map((entry) => entry.path),
    ).toEqual([
      "migrations/20260714100200_email_automation_cron.sql",
      "migrations/20260809170000_production_reconciliation_non_email.sql",
      "migrations/20260809171000_production_email_disabled_schema.sql",
      "migrations/20260810020000_production_assets_archived_at_select_grant.sql",
    ]);
    expect(
      manifest.productionOnly.every(
        (entry) => entry.executionMode === "production_manual_only",
      ),
    ).toBe(true);
    for (const entry of manifest.ordered.slice(1)) {
      expect(entry.dependsOn).toHaveLength(1);
    }
  });

  it("keeps archive-marker parity local-only without broadening financial grants", () => {
    const entry = manifest.ordered.at(-1)!;
    expect(entry.executionMode).toBe("local_rebuild_only");
    expect(entry.sha256).toBe(digest(entry.path));
    expect(entry.dependsOn).toEqual([manifest.ordered.at(-2)!.id]);
    const source = readFileSync(resolve(root, entry.path), "utf8");
    expect(source).toContain("grant select (archived_at) on table public.assets to authenticated;");
    expect(source).toContain("local bootstrap must preserve the financial column boundary");
    expect(source).toContain("local bootstrap requires asset RLS");
    expect(source).not.toMatch(/grant\s+select\s+on\s+(?:table\s+)?public\.assets/i);
  });

  it("replays the canonical purchase item nonfinancial read grants without broad table access", () => {
    const bootstrap = readFileSync(resolve(root, "scripts/test/bootstrap-baseline-privileges.sql"), "utf8");
    const canonical = ["migrations/20260705132000_purchase_requests.sql", "migrations/20260706130000_request_item_purchase_bridge.sql"]
      .map(path => readFileSync(resolve(root, path), "utf8")).join("\n");
    const readColumns = (source: string) => [...source.matchAll(/grant\s+select\s*\(([^)]+)\)\s+on\s+(?:table\s+)?public\.purchase_request_items\s+to\s+authenticated\s*;/gi)]
      .flatMap(match => match[1].split(",").map(column => column.trim())).sort();
    expect(readColumns(bootstrap)).toEqual(readColumns(canonical));
    expect(readColumns(bootstrap)).not.toContain("unit_cost");
    expect(bootstrap).toContain("revoke select on public.purchase_request_items from authenticated;");
    expect(bootstrap).toContain("revoke select (unit_cost) on public.purchase_request_items from authenticated;");
    expect(bootstrap).toContain("local bootstrap must preserve the purchase financial column boundary");
    expect(bootstrap).toContain("local bootstrap requires purchase item RLS");
  });

  it('makes checksum verification a prerequisite of a local replay plan',()=>{
    expect(packageJson.scripts['audit:migration-manifest']).toBe('node scripts/audit/generate-migration-manifest.mjs');
    expect(rebuild).toContain('Migration manifest verification failed before local reset');
    const plan=JSON.parse(execFileSync(process.execPath,['scripts/test/rebuild-supabase-e2e.mjs','--plan'],{cwd:root,encoding:'utf8'}));
    expect(plan.executed).toBe(false);expect(plan.steps).toEqual(manifest.ordered.map(entry=>entry.path));
    for(const excluded of plan.excluded)expect(plan.steps).not.toContain(excluded);
  });
  it('describes restore gaps while refusing database execution',()=>{
    expect(packageJson.scripts['test:restore:plan']).toContain('--plan');
    for(const gap of ['Storage object bytes outside PostgreSQL were not included.','The local manifest replay has no Supabase platform migration ledger','RPO and RTO were not approved or measured for production.'])expect(restore).toContain(gap);
    const plan=JSON.parse(execFileSync(process.execPath,['scripts/test/rehearse-local-restore.mjs','--plan'],{cwd:root,encoding:'utf8'}));expect(plan.executed).toBe(false);
    expect(()=>execFileSync(process.execPath,['scripts/test/rehearse-local-restore.mjs','--execute'],{cwd:root,stdio:'pipe'})).toThrow(/execution is disabled/);
  });
});
