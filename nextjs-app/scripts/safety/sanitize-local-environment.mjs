#!/usr/bin/env node
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { APPROVED_STAGING, assertApprovedSupabaseTarget } from "./production-boundary.mjs";
import { parseEnvText } from "./repository-targets.mjs";

const root = resolve(import.meta.dirname, "../..");
const execute = process.argv.includes("--execute");
if (process.argv.some((argument, index) => index > 1 && argument !== "--execute")) {
  throw new Error("Local environment sanitizer accepts only --execute.");
}

const managerPath = resolve(root, ".env.manager-demo.local");
if (!existsSync(managerPath)) {
  throw new Error("A verified local Staging source is required before sanitization.");
}
const manager = parseEnvText(readFileSync(managerPath, "utf8"));
assertApprovedSupabaseTarget({
  url: manager.get("NEXT_PUBLIC_SUPABASE_URL"),
  projectRef: manager.get("SUPABASE_PROJECT_REF"),
});
const publishableKey = manager.get("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
if (!publishableKey) throw new Error("The Staging publishable key source is missing.");

const envPath = resolve(root, ".env.local");
let envChanges = 0;
if (existsSync(envPath)) {
  const output = [];
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const separator = line.indexOf("=");
    const key = separator > 0 ? line.slice(0, separator).trim() : "";
    if ([
      "ITAM_PRODUCTION_DB_URL",
      "SUPABASE_PRODUCTION_DB_PASSWORD",
      "SUPABASE_ACCESS_TOKEN",
      "VERCEL_TOKEN",
    ].includes(key)) {
      envChanges += 1;
      continue;
    }
    if (key === "NEXT_PUBLIC_SUPABASE_URL") {
      output.push(`NEXT_PUBLIC_SUPABASE_URL=https://${APPROVED_STAGING.supabaseApiHost}`);
      envChanges += 1;
      continue;
    }
    if (key === "NEXT_PUBLIC_SUPABASE_ANON_KEY") {
      output.push(`NEXT_PUBLIC_SUPABASE_ANON_KEY=${publishableKey}`);
      envChanges += 1;
      continue;
    }
    if (key === "SUPABASE_PROJECT_ID") {
      output.push(`SUPABASE_PROJECT_ID=${APPROVED_STAGING.supabaseProjectRef}`);
      envChanges += 1;
      continue;
    }
    output.push(line);
  }
  if (execute) {
    writeFileSync(envPath, output.join("\n").replace(/\n*$/, "\n"), { mode: 0o600 });
    chmodSync(envPath, 0o600);
  }
}

const credentialsPath = resolve(root, ".manager-demo-credentials.local");
let credentialSectionsRemoved = 0;
if (existsSync(credentialsPath)) {
  const lines = readFileSync(credentialsPath, "utf8").split(/\r?\n/);
  const output = [];
  let blockedSection = false;
  for (const line of lines) {
    const section = line.trim().match(/^\[([^\]]+)\]$/)?.[1] ?? "";
    if (section) {
      blockedSection = section.startsWith("account.production_");
      if (blockedSection) {
        credentialSectionsRemoved += 1;
        continue;
      }
    }
    if (!blockedSection && !line.includes("Production-only controlled smoke fixture")) {
      output.push(line);
    }
  }
  if (execute) {
    writeFileSync(credentialsPath, output.join("\n").replace(/\n*$/, "\n"), { mode: 0o600 });
    chmodSync(credentialsPath, 0o600);
  }
}

console.log(JSON.stringify({
  mode: execute ? "executed" : "dry-run",
  activeEnvironmentBindingsSanitized: envChanges,
  productionCredentialSectionsRemoved: credentialSectionsRemoved,
  secretsPrinted: false,
}));
