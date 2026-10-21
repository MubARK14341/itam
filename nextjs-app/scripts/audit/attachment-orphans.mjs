import process from "node:process";
import {resolve} from "node:path";
import { spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { assertApprovedOrLocalSupabaseTarget } from "../safety/production-boundary.mjs";

const PAGE_SIZE = 100;
const MAX_OBJECTS = Number(process.env.ATTACHMENT_AUDIT_MAX_OBJECTS ?? "10000");

function help() {
  console.log(`Read-only attachment orphan inventory.

Required environment:
  ATTACHMENT_AUDIT_URL
  ATTACHMENT_AUDIT_SERVICE_ROLE_KEY
  ATTACHMENT_AUDIT_EXPECTED_PROJECT_REF

For the disposable local stack instead:
  ATTACHMENT_AUDIT_USE_LOCAL_SUPABASE=true

Hosted targets are disabled in this publication copy. Reserved .invalid values
are synthetic policy fixtures, never authorized service coordinates. The script has no delete mode.`);
}

if (process.argv.includes("--help")) {
  help();
} else {
  await main();
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment: ${name}`);
  return value;
}

function targetRef(url) {
  const target = new URL(url);
  return ["127.0.0.1", "localhost"].includes(target.hostname)
    ? "local"
    : target.hostname.split(".")[0];
}

async function main() {
  const {
    url,
    serviceRoleKey,
    expectedRef,
  } = process.env.ATTACHMENT_AUDIT_USE_LOCAL_SUPABASE === "true"
    ? localConfig()
    : {
        url: required("ATTACHMENT_AUDIT_URL"),
        serviceRoleKey: required("ATTACHMENT_AUDIT_SERVICE_ROLE_KEY"),
        expectedRef: required("ATTACHMENT_AUDIT_EXPECTED_PROJECT_REF"),
      };
  const actualRef = targetRef(url);

  assertApprovedOrLocalSupabaseTarget({
    url,
    projectRef: expectedRef,
  });
  if (actualRef !== expectedRef) throw new Error("Attachment audit target mismatch.");
  if (!Number.isInteger(MAX_OBJECTS) || MAX_OBJECTS < 1 || MAX_OBJECTS > 100000) {
    throw new Error("ATTACHMENT_AUDIT_MAX_OBJECTS must be an integer from 1 to 100000");
  }

  const client = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const [genericObjects, requestObjects, genericRows, requestRows] = await Promise.all([
    listAllObjects(client, "attachments"),
    listAllObjects(client, "request-attachments"),
    listRegisteredPaths(client, "attachments"),
    listRegisteredPaths(client, "request_attachments"),
  ]);

  const genericRegistered = new Set(genericRows);
  const requestRegistered = new Set(requestRows);
  const report = {
    target_ref: actualRef,
    generated_at: new Date().toISOString(),
    mode: "read_only_dry_run",
    deletion_supported: false,
    buckets: {
      attachments: summarize(genericObjects, genericRegistered),
      "request-attachments": summarize(requestObjects, requestRegistered),
    },
  };
  console.log(JSON.stringify(report, null, 2));
}

function localConfig() {
  const status = spawnSync(
    resolve(import.meta.dirname, "../../node_modules/.bin/supabase"),
    ["status", "--output", "env", "--workdir", resolve(import.meta.dirname, "../..")],
    { encoding: "utf8", stdio: "pipe" },
  );
  if (status.status !== 0) {
    throw new Error("Could not read the disposable local Supabase status");
  }
  const values = new Map();
  for (const line of status.stdout.split(/\r?\n/)) {
    const match = line.match(
      /^\s*([A-Z][A-Z0-9_]*)=(?:"([^"]*)"|'([^']*)'|(\S+))\s*$/,
    );
    if (match) values.set(match[1], match[2] ?? match[3] ?? match[4]);
  }
  const url = values.get("API_URL");
  const serviceRoleKey = values.get("SERVICE_ROLE_KEY") ?? values.get("SECRET_KEY");
  if (!url || !serviceRoleKey) {
    throw new Error("Local Supabase did not return an API URL and service-role key");
  }
  return { url, serviceRoleKey, expectedRef: "local" };
}

function summarize(objects, registered) {
  const objectSet = new Set(objects);
  return {
    object_count: objects.length,
    metadata_count: registered.size,
    orphan_objects: objects.filter((path) => !registered.has(path)).sort(),
    missing_objects: [...registered].filter((path) => !objectSet.has(path)).sort(),
  };
}

async function listRegisteredPaths(client, table) {
  const paths = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await client
      .from(table)
      .select("storage_path")
      .range(offset, offset + 999);
    if (error) throw error;
    paths.push(...(data ?? []).map(({ storage_path }) => storage_path));
    if ((data ?? []).length < 1000) return paths;
  }
}

async function listAllObjects(client, bucket) {
  const paths = [];
  const prefixes = [""];
  while (prefixes.length > 0) {
    const prefix = prefixes.pop();
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const { data, error } = await client.storage.from(bucket).list(prefix, {
        limit: PAGE_SIZE,
        offset,
        sortBy: { column: "name", order: "asc" },
      });
      if (error) throw error;
      for (const entry of data ?? []) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.id) paths.push(path);
        else prefixes.push(path);
        if (paths.length > MAX_OBJECTS) {
          throw new Error(
            `Object safety cap exceeded in ${bucket}; raise ATTACHMENT_AUDIT_MAX_OBJECTS explicitly`,
          );
        }
      }
      if ((data ?? []).length < PAGE_SIZE) break;
    }
  }
  return paths;
}
