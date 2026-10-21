import { createHash } from "node:crypto";
import {
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

const ROOT = resolve(import.meta.dirname, "../..");
const MANIFEST_PATH = resolve(
  ROOT,
  "docs/audit-remediation/MIGRATION_MANIFEST.json",
);
const SUMMARY_PATH = resolve(
  ROOT,
  "docs/audit-remediation/MIGRATION_MANIFEST.md",
);
const BASELINE_PATH = "migrations/_baseline/00_full_db_snapshot_20260707.sql";
const PRIVILEGE_BOOTSTRAP_PATH = "scripts/test/bootstrap-baseline-privileges.sql";
const AUTHZ_BOOTSTRAP_PATH = "scripts/test/bootstrap-pre-remediation-authz.sql";
const OPERATIONAL_GRANTS_BOOTSTRAP_PATH = "scripts/test/bootstrap-operational-assets-grants.sql";
const FIRST_POST_BASELINE = "20260707030000";
const FIRST_REMEDIATION = "20260727144004";
const GRANT_CORRECTION =
  "20260701150032_high1b_financial_column_grants_correction.sql";
const PRODUCTION_ONLY = new Set([
  "20260714100200_email_automation_cron.sql",
  "20260809170000_production_reconciliation_non_email.sql",
  "20260809171000_production_email_disabled_schema.sql",
  "20260810020000_production_assets_archived_at_select_grant.sql",
]);

function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
}

function fileSource(path) {
  return readFileSync(resolve(ROOT, path), "utf8");
}

function purposeFor(name, source) {
  const explicit = source.match(/^--\s*Purpose:\s*(.+)$/im)?.[1]?.trim();
  if (explicit) return explicit;
  return name
    .replace(/^\d{14}_/, "")
    .replace(/\.sql$/, "")
    .replaceAll("_", " ");
}

function migrationId(name) {
  return name.replace(/\.sql$/, "");
}

function makeEntry({
  path,
  id,
  kind,
  executionMode,
  purpose,
  dependsOn = [],
}) {
  const source = fileSource(path);
  return {
    id,
    path,
    kind,
    executionMode,
    purpose: purpose ?? purposeFor(path.split("/").at(-1), source),
    dependsOn,
    sha256: sha256(source),
  };
}

function buildManifest() {
  const migrationNames = readdirSync(resolve(ROOT, "migrations"))
    .filter((name) => /^\d{14}_.+\.sql$/.test(name))
    .sort();
  const timestamps = migrationNames.map((name) => name.slice(0, 14));
  if (new Set(timestamps).size !== timestamps.length) {
    throw new Error("Duplicate 14-digit migration timestamp detected.");
  }

  const replayNames = migrationNames.filter(
    (name) =>
      name === GRANT_CORRECTION
      || (
        name.slice(0, 14) >= FIRST_POST_BASELINE
        && !PRODUCTION_ONLY.has(name)
      ),
  );
  const absorbedNames = migrationNames.filter(
    (name) =>
      name.slice(0, 14) < FIRST_POST_BASELINE
      && name !== GRANT_CORRECTION,
  );
  const productionOnlyNames = migrationNames.filter((name) =>
    PRODUCTION_ONLY.has(name)
  );

  const ordered = [];
  let previous = null;
  const append = (entry) => {
    const withDependency = {
      order: ordered.length + 1,
      ...entry,
      dependsOn: previous ? [previous] : [],
    };
    ordered.push(withDependency);
    previous = entry.id;
  };

  append(
    makeEntry({
      path: BASELINE_PATH,
      id: "baseline_20260707",
      kind: "baseline",
      executionMode: "local_rebuild",
      purpose:
        "Restore the reviewed data-free public schema snapshot that replaces the missing foundational migration files.",
    }),
  );
  append(
    makeEntry({
      path: PRIVILEGE_BOOTSTRAP_PATH,
      id: "bootstrap_baseline_privileges",
      kind: "local_test_bootstrap",
      executionMode: "local_rebuild_only",
      purpose:
        "Restore a fail-closed ACL starting point omitted by the generated baseline; never apply this test bootstrap to production.",
    }),
  );
  append(
    makeEntry({
      path: `migrations/${GRANT_CORRECTION}`,
      id: migrationId(GRANT_CORRECTION),
      kind: "migration",
      executionMode: "local_rebuild",
    }),
  );

  const beforeRemediation = replayNames.filter(
    (name) =>
      name !== GRANT_CORRECTION
      && name.slice(0, 14) < FIRST_REMEDIATION,
  );
  const remediationAndLater = replayNames.filter(
    (name) => name.slice(0, 14) >= FIRST_REMEDIATION,
  );
  for (const name of beforeRemediation) {
    append(
      makeEntry({
        path: `migrations/${name}`,
        id: migrationId(name),
        kind: "migration",
        executionMode: "local_rebuild",
      }),
    );
  }
  append(
    makeEntry({
      path: AUTHZ_BOOTSTRAP_PATH,
      id: "bootstrap_pre_remediation_authz",
      kind: "local_test_bootstrap",
      executionMode: "local_rebuild_only",
      purpose:
        "Seed deterministic synthetic authorization reference rows omitted by the data-free baseline; never apply this test bootstrap to production.",
    }),
  );
  for (const name of remediationAndLater) {
    append(
      makeEntry({
        path: `migrations/${name}`,
        id: migrationId(name),
        kind: "migration",
        executionMode: "local_rebuild",
      }),
    );
  }
  append(
    makeEntry({
      path: OPERATIONAL_GRANTS_BOOTSTRAP_PATH,
      id: "bootstrap_operational_assets_grants",
      kind: "local_test_bootstrap",
      executionMode: "local_rebuild_only",
      purpose:
        "Mirror only the reviewed non-financial archive-marker grant for disposable local UI verification; preserve financial ACLs and never execute this bootstrap on a hosted database.",
    }),
  );

  const absorbed = absorbedNames.map((name) =>
    makeEntry({
      path: `migrations/${name}`,
      id: migrationId(name),
      kind: "migration",
      executionMode: "absorbed_by_baseline",
      purpose:
        `${purposeFor(name, fileSource(`migrations/${name}`))} (captured by the 2026-07-07 baseline and not replayed on top of it).`,
      dependsOn: ["baseline_20260707"],
    })
  );
  const productionOnly = productionOnlyNames.map((name) =>
    makeEntry({
      path: `migrations/${name}`,
      id: migrationId(name),
      kind: "migration",
      executionMode: "production_manual_only",
      purpose:
        `${purposeFor(name, fileSource(`migrations/${name}`))} (excluded from local replay because it requires an approved Production-only execution window).`,
      dependsOn: [migrationId("20260714100100_email_automation_enqueue.sql")],
    })
  );

  const digestInput = JSON.stringify({
    ordered,
    absorbed,
    productionOnly,
  });
  return {
    manifestVersion: 1,
    contract: "itam-local-rebuild",
    baselineCutover: FIRST_POST_BASELINE,
    notes: [
      "No user data or secrets are part of this manifest.",
      "The baseline replaces uncommitted foundational migrations; absorbed entries are retained for provenance and checksum review only.",
      "Production-only scheduling is never executed by the local rebuild.",
      "A production-equivalent restore and remote migration-ledger reconciliation remain blocked on authorized staging access.",
    ],
    digestAlgorithm: "sha256",
    manifestDigest: sha256(digestInput),
    ordered,
    absorbed,
    productionOnly,
  };
}

function renderJson(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function renderMarkdown(manifest) {
  const rows = manifest.ordered
    .map(
      (entry) =>
        `| ${entry.order} | \`${entry.id}\` | ${entry.executionMode} | ` +
        `\`${entry.sha256.slice(0, 12)}…\` | ` +
        `${entry.dependsOn.map((id) => `\`${id}\``).join(", ") || "—"} |`,
    )
    .join("\n");
  return `# Migration Manifest

Generated by \`node scripts/audit/generate-migration-manifest.mjs\`. Do not edit
the generated JSON or ordered rows manually.

## Contract

- Manifest digest: \`${manifest.manifestDigest}\`
- Ordered local rebuild steps: ${manifest.ordered.length}
- Incremental files absorbed by the baseline: ${manifest.absorbed.length}
- Production-only manual files: ${manifest.productionOnly.length}
- Missing foundational history is represented by
  \`migrations/_baseline/00_full_db_snapshot_20260707.sql\`; it is not claimed to
  be an authoritative production backup.
- The three bootstrap SQL files contain synthetic/reference state and operational
  grant parity for a disposable
  local rebuild only and are prohibited in production.

## Ordered local rebuild

| Order | Step | Mode | SHA-256 | Depends on |
| ---: | --- | --- | --- | --- |
${rows}

## Classification rules

- Files before \`${FIRST_POST_BASELINE}\` are already represented structurally by
  the baseline and are not replayed on top of it, except the explicit financial
  column-grant correction omitted by the snapshot.
- The authorization bootstrap is inserted immediately before the remediation
  chain because the baseline intentionally contains no row data.
- The final local-only bootstrap mirrors the non-financial asset archive-marker
  grant while asserting that financial columns and anonymous access remain denied.
  It does not reclassify or execute the Production-only grant migration.
- Production-only manual files are listed in the JSON manifest but excluded from
  local execution.
- Every listed source file has a SHA-256 checksum. Run
  \`npm run audit:migration-manifest\` in CI before any build or migration review.
`;
}

const manifest = buildManifest();
const expectedJson = renderJson(manifest);
const expectedMarkdown = renderMarkdown(manifest);
const write = process.argv.includes("--write");

if (write) {
  writeFileSync(MANIFEST_PATH, expectedJson);
  writeFileSync(SUMMARY_PATH, expectedMarkdown);
  console.log(
    `Wrote migration manifest ${manifest.manifestDigest} ` +
    `(${manifest.ordered.length} ordered steps).`,
  );
} else {
  const actualJson = readFileSync(MANIFEST_PATH, "utf8");
  const actualMarkdown = readFileSync(SUMMARY_PATH, "utf8");
  if (actualJson !== expectedJson || actualMarkdown !== expectedMarkdown) {
    throw new Error(
      "Migration manifest is stale. Run " +
      "`node scripts/audit/generate-migration-manifest.mjs --write` and review the diff.",
    );
  }
  console.log(
    `Migration manifest verified: ${manifest.manifestDigest} ` +
    `(${manifest.ordered.length} ordered steps, ${migrationId(GRANT_CORRECTION)} replayed).`,
  );
}
