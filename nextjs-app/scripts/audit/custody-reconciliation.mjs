import process from "node:process";
import {resolve} from "node:path";
import { spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { assertApprovedOrLocalSupabaseTarget } from "../safety/production-boundary.mjs";

if (process.argv.includes("--help")) {
  console.log(`Read-only custody reconciliation CSV export.

Required environment:
  CUSTODY_AUDIT_URL
  CUSTODY_AUDIT_SERVICE_ROLE_KEY
  CUSTODY_AUDIT_EXPECTED_PROJECT_REF

For the disposable local stack:
  CUSTODY_AUDIT_USE_LOCAL_SUPABASE=true

Hosted targets are disabled in this publication copy. Reserved .invalid values
are synthetic policy fixtures, never authorized service coordinates. CSV is written to stdout.`);
} else {
  await main();
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment: ${name}`);
  return value;
}

function parseStatus(output) {
  const values = new Map();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(
      /^\s*([A-Z][A-Z0-9_]*)=(?:"([^"]*)"|'([^']*)'|(\S+))\s*$/,
    );
    if (match) values.set(match[1], match[2] ?? match[3] ?? match[4]);
  }
  return values;
}

function localConfig() {
  const status = spawnSync(
    resolve(import.meta.dirname, "../../node_modules/.bin/supabase"),
    ["status", "--output", "env", "--workdir", resolve(import.meta.dirname, "../..")],
    { encoding: "utf8", stdio: "pipe" },
  );
  if (status.status !== 0) throw new Error("Could not read local Supabase status");
  const values = parseStatus(status.stdout);
  const url = values.get("API_URL");
  const serviceRoleKey = values.get("SERVICE_ROLE_KEY") ?? values.get("SECRET_KEY");
  if (!url || !serviceRoleKey) throw new Error("Local Supabase credentials missing");
  return { url, serviceRoleKey, expectedRef: "local" };
}

function projectRef(url) {
  const target = new URL(url);
  return ["localhost", "127.0.0.1"].includes(target.hostname)
    ? "local"
    : target.hostname.split(".")[0];
}

function csv(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function main() {
  const config = process.env.CUSTODY_AUDIT_USE_LOCAL_SUPABASE === "true"
    ? localConfig()
    : {
        url: required("CUSTODY_AUDIT_URL"),
        serviceRoleKey: required("CUSTODY_AUDIT_SERVICE_ROLE_KEY"),
        expectedRef: required("CUSTODY_AUDIT_EXPECTED_PROJECT_REF"),
      };
  const actualRef = projectRef(config.url);
  assertApprovedOrLocalSupabaseTarget({
    url: config.url,
    projectRef: config.expectedRef,
  });
  if (actualRef !== config.expectedRef) throw new Error("Custody audit target mismatch.");

  const client = createClient(config.url, config.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await client
      .from("custody_reconciliation_cases")
      .select(
        "id,asset_id,anomaly_code,status,detected_at,last_detected_at,snapshot,assigned_to,resolution_code,resolution_notes,evidence_ref,resolved_at,resolved_by",
      )
      .order("detected_at")
      .order("id")
      .range(offset, offset + 999);
    if (error) throw error;
    rows.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }

  const columns = [
    "case_id",
    "asset_id",
    "asset_tag",
    "anomaly_code",
    "status",
    "asset_status_snapshot",
    "holder_employee_id_snapshot",
    "active_assignment_count_snapshot",
    "detected_at",
    "last_detected_at",
    "assigned_to",
    "resolution_code",
    "resolution_notes",
    "evidence_ref",
    "resolved_at",
    "resolved_by",
  ];
  console.log(columns.join(","));
  for (const row of rows) {
    const snapshot = row.snapshot ?? {};
    console.log([
      row.id,
      row.asset_id,
      snapshot.asset_tag,
      row.anomaly_code,
      row.status,
      snapshot.asset_status,
      snapshot.holder_employee_id,
      snapshot.active_assignment_count,
      row.detected_at,
      row.last_detected_at,
      row.assigned_to,
      row.resolution_code,
      row.resolution_notes,
      row.evidence_ref,
      row.resolved_at,
      row.resolved_by,
    ].map(csv).join(","));
  }
}
