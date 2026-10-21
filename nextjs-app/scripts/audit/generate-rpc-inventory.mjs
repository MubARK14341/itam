import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { relative, resolve } from "node:path";
import process from "node:process";
import { functionBodyPatchTargets } from "./rpc-migration-targets.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const OUTPUT = resolve(ROOT, "docs/audit-remediation/RPC_INVENTORY.md");
const CHECK = process.argv.includes("--check");

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const path = resolve(directory, entry);
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  return files;
}

function sourceRpcCalls() {
  const calls = new Map();
  const files = walk(resolve(ROOT, "src"))
    .filter((file) => /\.(ts|tsx)$/.test(file) && !file.endsWith(".test.ts"));
  const direct = /\.rpc\s*\(\s*["'`]([a-z][a-z0-9_]*)["'`]/g;
  const helper =
    /\b(?:assetRpc|requestRpc|portalRpc|prRpc|actionRpc|rpc)\s*\(\s*["'`]([a-z][a-z0-9_]*)["'`]/g;
  const financial =
    /\bmergeFinancial\s*\(.*?,\s*["'`]([a-z][a-z0-9_]*)["'`]/g;

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const lines = source.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      for (const pattern of [direct, helper, financial]) {
        pattern.lastIndex = 0;
        for (const match of line.matchAll(pattern)) {
          const name = match[1];
          const location = `${relative(ROOT, file)}:${index + 1}`;
          if (!calls.has(name)) calls.set(name, new Set());
          calls.get(name).add(location);
        }
      }
    }
  }
  return calls;
}

function migrationDefinitions() {
  const definitions = new Map();
  const created = new Set();
  const migrationFiles = readdirSync(resolve(ROOT, "migrations"))
    .filter((name) => /^\d{14}_.+\.sql$/.test(name))
    .sort();
  const definition =
    /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z][a-z0-9_]*)\s*\(/gi;

  for (const name of migrationFiles) {
    const source = readFileSync(resolve(ROOT, "migrations", name), "utf8");
    for (const match of source.matchAll(definition)) {
      created.add(match[1]);
      if (!definitions.has(match[1])) definitions.set(match[1], []);
      definitions.get(match[1]).push(`migrations/${name}`);
    }
    for (const target of functionBodyPatchTargets(source)) {
      if (!definitions.has(target)) definitions.set(target, []);
      const history = definitions.get(target);
      if (history.at(-1) !== `migrations/${name}`) history.push(`migrations/${name}`);
    }
  }

  const baselinePath = resolve(
    ROOT,
    "migrations/_baseline/00_full_db_snapshot_20260707.sql",
  );
  const baseline = readFileSync(baselinePath, "utf8");
  for (const match of baseline.matchAll(definition)) {
    if (!definitions.has(match[1])) {
      definitions.set(match[1], [
        "migrations/_baseline/00_full_db_snapshot_20260707.sql (baseline-only)",
      ]);
    } else if (!created.has(match[1])) {
      definitions.get(match[1]).unshift("migrations/_baseline/00_full_db_snapshot_20260707.sql (baseline creation)");
      created.add(match[1]);
    }
  }
  return definitions;
}

function directTests(name) {
  const files = [
    ...walk(resolve(ROOT, "src")).filter((file) => file.endsWith(".test.ts")),
    ...walk(resolve(ROOT, "tests")).filter((file) => /\.(ts|tsx)$/.test(file)),
  ];
  const matches = files
    .filter((file) => readFileSync(file, "utf8").includes(name))
    .map((file) => relative(ROOT, file));
  return matches.length ? matches.join("<br>") : "No direct name assertion";
}

function operation(name) {
  if (name.startsWith("portal_")) return "Portal/customer isolation";
  if (name.startsWith("request_")) return "Request workflow";
  if (name.startsWith("purchase_")) return "Procurement";
  if (name.startsWith("asset_") || name.startsWith("assets_")) return "Asset/custody";
  if (name.startsWith("consumable")) return "Consumable/stock";
  if (name.startsWith("maintenance_")) return "Maintenance";
  if (name.startsWith("scan_warehouse_")) return "Confirmed warehouse scan transfer";
  if (name.includes("financial") || name === "depreciation_financial") return "Financial projection";
  if (name.startsWith("dashboard_")) return "Dashboard aggregate";
  if (name.startsWith("action_")) return "Action center";
  if (name.includes("registration") || name.endsWith("_user")) return "Identity/admin";
  if (name.includes("capabilit")) return "Authorization";
  if (name.includes("attachment")) return "Attachment";
  if (name.includes("analytics") || name.includes("timeseries") || name.includes("report")) return "Analytics";
  return "Reference/read helper";
}

function permission(name) {
  if (name === "public_asset_by_token" || name.startsWith("validate_")) {
    return "anon/authenticated; minimal public contract";
  }
  if (name.startsWith("portal_")) {
    return "authenticated portal identity; customer/self scoped";
  }
  if (name.includes("financial") || name === "depreciation_financial") {
    return "authenticated; self-gated to admin/it_manager";
  }
  if (
    name.includes("approve_user")
    || name === "approve_employee_user"
    || name.includes("reject_user")
    || name.includes("capability")
    || name.startsWith("set_customer_")
    || name.startsWith("create_customer_")
  ) {
    return "authenticated; manager/admin predicate";
  }
  if (name === "request_create_employee_self") {
    return "authenticated approved employee; self scoped";
  }
  return "authenticated; approved role/capability predicate";
}

function markdown() {
  const calls = sourceRpcCalls();
  const definitions = migrationDefinitions();
  const names = [...calls.keys()].sort();
  const rows = names.map((name) => {
    const sources = [...calls.get(name)].sort().join("<br>");
    const migrations = definitions.get(name) ?? [];
    const source = migrations.length
      ? `${migrations[0]}${migrations.length > 1 ? `<br>latest: ${migrations.at(-1)}` : ""}`
      : "**MISSING**";
    return `| \`${name}\` | ${operation(name)} | ${sources} | ${source} | ${permission(name)} | ${directTests(name)} |`;
  });
  const missing = names.filter((name) => !definitions.has(name));
  const baselineOnly = names.filter((name) =>
    definitions.get(name)?.some((file) => file.includes("baseline-only")));

  return `# RPC Inventory

Generated by \`node scripts/audit/generate-rpc-inventory.mjs\`.
Do not edit rows manually; run the generator and review the diff.

## Summary

- Application RPC names: ${names.length}
- Missing from repository SQL: ${missing.length}
- Baseline-only definitions: ${baselineOnly.length}
- Clean local runtime contract: covered separately by \`npm run test:e2e\`.

Latest migrations include reviewed executable function-body patches. Read-only
\`pg_get_functiondef\` lookups and unrelated SQL references do not count as definitions.

| RPC | Operation | Caller(s) | Creating/latest migration | Required authorization | Direct test reference |
| --- | --- | --- | --- | --- | --- |
${rows.join("\n")}

## Gaps

Missing definitions: ${missing.length ? missing.map((name) => `\`${name}\``).join(", ") : "none"}.

Baseline-only definitions: ${baselineOnly.length
  ? baselineOnly.map((name) => `\`${name}\``).join(", ")
  : "none"}.

\`baseline-only\` is documented evidence, not proof of an ordered reproducible
migration chain. Those entries remain part of P1-01 until the foundational migration
history or an authoritative full restore is available.
`;
}

const generated = markdown();
if (CHECK) {
  if (!existsSync(OUTPUT) || readFileSync(OUTPUT, "utf8") !== generated) {
    throw new Error(
      "RPC inventory is stale. Run node scripts/audit/generate-rpc-inventory.mjs.",
    );
  }
  console.log("RPC inventory is current.");
} else {
  writeFileSync(OUTPUT, generated);
  console.log(`Wrote ${relative(ROOT, OUTPUT)}.`);
}
