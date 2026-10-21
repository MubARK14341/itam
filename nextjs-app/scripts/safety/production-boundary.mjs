const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);

/** Synthetic test policy only: .invalid cannot designate a hosted service. */
export const APPROVED_STAGING = Object.freeze({
 supabaseProjectRef:'synthetic-staging', supabaseProjectName:'synthetic-staging',
 supabaseOrganization:'synthetic-organization', supabaseApiHost:'database.example.invalid',
 supabaseDatabaseHost:'db.database.example.invalid', supabaseDatabaseName:'postgres',
 vercelProjectId:'fixture-preview', vercelProjectName:'synthetic-preview',
 vercelTeamId:'fixture-team', vercelScope:'fixture-owner', fixedPreviewHost:'preview.example.invalid',
});
export const DENIED_PRODUCTION = Object.freeze({
 supabaseProjectRefs:Object.freeze(['synthetic-production']),
 vercelProjectNames:Object.freeze(['synthetic-production']),
 hostnames:Object.freeze(['production.example.invalid']),
});

const FORBIDDEN_BRANCH = /^(main|master|prod|production)$/i;
const GENERATED_PREVIEW_HOST = /^preview-[a-z0-9-]+\.example\.invalid$/;

export class ProductionBoundaryError extends Error {
  constructor(issues) {
    super(`Production boundary check failed:\n- ${issues.join("\n- ")}`);
    this.name = "ProductionBoundaryError";
    this.issues = issues;
  }
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function required(value, label, issues) {
  const normalized = text(value);
  if (!normalized) issues.push(`${label} is required; safety checks fail closed.`);
  return normalized;
}

function parseUrl(value, label, issues, protocols) {
  const normalized = required(value, label, issues);
  if (!normalized) return null;
  try {
    const parsed = new URL(normalized);
    if (!protocols.includes(parsed.protocol)) {
      issues.push(`${label} uses a disallowed protocol.`);
    }
    return parsed;
  } catch {
    issues.push(`${label} is not a valid URL.`);
    return null;
  }
}

export function containsDeniedProductionIdentifier(value) {
  const normalized = text(value).toLowerCase();
  if (!normalized) return false;
  return [
    ...DENIED_PRODUCTION.supabaseProjectRefs,
    ...DENIED_PRODUCTION.vercelProjectNames,
    ...DENIED_PRODUCTION.hostnames,
  ].some((identifier) => normalized.includes(identifier.toLowerCase()));
}

function rejectDenied(value, label, issues) {
  if (containsDeniedProductionIdentifier(value)) {
    issues.push(`${label} contains a denylisted Production identifier.`);
  }
}

export function supabaseProjectRefFromUrl(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    if (LOCAL_HOSTS.has(hostname)) return "local";
    const apiMatch = hostname.match(/^([a-z0-9]{8,})\.supabase\.co$/);
    if (apiMatch) return apiMatch[1];
    const databaseMatch = hostname.match(/^db\.([a-z0-9]{8,})\.supabase\.co$/);
    return databaseMatch?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * @param {{url?: string, projectRef?: string, databaseHost?: string, databaseName?: string, allowLocal?: boolean}} [target]
 */
export function validateApprovedSupabaseTarget({
  url,
  projectRef,
  databaseHost,
  databaseName,
  allowLocal = false,
} = {}) {
  const issues = [];
  const declaredRef = required(projectRef, "Supabase project reference", issues).toLowerCase();
  const parsed = parseUrl(url, "Supabase URL", issues, ["https:", "http:"]);

  rejectDenied(projectRef, "Supabase project reference", issues);
  rejectDenied(url, "Supabase URL", issues);
  rejectDenied(databaseHost, "Supabase database host", issues);

  const isDemo = parsed?.origin === 'https://demo.invalid';
  const isLocal = parsed ? LOCAL_HOSTS.has(parsed.hostname.toLowerCase()) : false;
  if (isDemo) {
    if (!allowLocal || declaredRef !== 'demo' || parsed.pathname !== '/' || parsed.search || parsed.hash) issues.push('Invalid offline demo target.');
  } else if (isLocal) {
    if (!allowLocal) issues.push("Local Supabase is not allowed for this hosted operation.");
    if (declaredRef !== "local") issues.push("Local Supabase must declare project reference local.");
  } else {
    if (declaredRef !== APPROVED_STAGING.supabaseProjectRef) {
      issues.push("Supabase project reference is not the approved Staging project.");
    }
    if (parsed?.protocol !== "https:" || parsed?.hostname.toLowerCase() !== APPROVED_STAGING.supabaseApiHost) {
      issues.push("Supabase URL is not the approved Staging API origin.");
    }
    if (parsed && (parsed.username || parsed.password || (parsed.port && parsed.port !== "443"))) {
      issues.push("Supabase URL must use the credential-free default HTTPS origin.");
    }
    if (parsed && (parsed.pathname !== "/" || parsed.search || parsed.hash)) {
      issues.push("Supabase URL must not contain a path, query, or fragment.");
    }
  }

  if (databaseHost !== undefined) {
    const host = required(databaseHost, "Supabase database host", issues).toLowerCase();
    if (isLocal) {
      if (!LOCAL_HOSTS.has(host)) issues.push("Local database host must be loopback.");
    } else if (host !== APPROVED_STAGING.supabaseDatabaseHost) {
      issues.push("Supabase database host is not the approved Staging database host.");
    }
  }

  if (databaseName !== undefined) {
    const name = required(databaseName, "Supabase database name", issues);
    if (name !== APPROVED_STAGING.supabaseDatabaseName) {
      issues.push("Supabase database name is not the approved Staging database name.");
    }
  }

  if (issues.length) return { ok: false, issues };
  return { ok: true, identity: { kind: isDemo ? "demo" : isLocal ? "local" : "staging", projectRef: declaredRef } };
}

export function assertApprovedSupabaseTarget(target) {
  const result = validateApprovedSupabaseTarget(target);
  if (!result.ok) throw new ProductionBoundaryError(result.issues);
  return result.identity;
}

export function assertApprovedOrLocalSupabaseTarget(target) {
  const result = validateApprovedSupabaseTarget({ ...target, allowLocal: true });
  if (!result.ok) throw new ProductionBoundaryError(result.issues);
  return result.identity;
}

export function validateApprovedVercelProject({ projectId, projectName, teamId } = {}) {
  const issues = [];
  const id = required(projectId, "Vercel project ID", issues);
  const name = required(projectName, "Vercel project name", issues);
  const team = required(teamId, "Vercel team ID", issues);

  rejectDenied(id, "Vercel project ID", issues);
  rejectDenied(name, "Vercel project name", issues);
  rejectDenied(team, "Vercel team ID", issues);

  if (id !== APPROVED_STAGING.vercelProjectId) {
    issues.push("Vercel project ID is not the approved Staging project.");
  }
  if (name !== APPROVED_STAGING.vercelProjectName) {
    issues.push("Vercel project name is not the approved Staging project.");
  }
  if (team !== APPROVED_STAGING.vercelTeamId) {
    issues.push("Vercel team ID is not the approved Staging team.");
  }

  if (issues.length) return { ok: false, issues };
  return { ok: true, identity: { projectId: id, projectName: name, teamId: team } };
}

export function assertApprovedVercelProject(target) {
  const result = validateApprovedVercelProject(target);
  if (!result.ok) throw new ProductionBoundaryError(result.issues);
  return result.identity;
}

export function validateApprovedHostedQaUrl(value) {
  const issues = [];
  const parsed = parseUrl(value, "Hosted QA URL", issues, ["https:"]);
  rejectDenied(value, "Hosted QA URL", issues);
  if (parsed) {
    const hostname = parsed.hostname.toLowerCase();
    const approved = hostname === APPROVED_STAGING.fixedPreviewHost
      || GENERATED_PREVIEW_HOST.test(hostname);
    if (!approved) issues.push("Hosted QA URL is not an approved Staging Preview hostname.");
    if (parsed.username || parsed.password) issues.push("Hosted QA URL must not embed credentials.");
    if (parsed.port && parsed.port !== "443") issues.push("Hosted QA URL must use the default HTTPS port.");
  }
  if (issues.length) return { ok: false, issues };
  return { ok: true, url: parsed };
}

export function assertApprovedHostedQaUrl(value) {
  const result = validateApprovedHostedQaUrl(value);
  if (!result.ok) throw new ProductionBoundaryError(result.issues);
  if (!result.url) throw new ProductionBoundaryError(["Hosted QA URL is required."]);
  return result.url;
}

export function validateApprovedVercelShareUrl(value, hostedQaUrl) {
  const issues = [];
  const hostedResult = validateApprovedHostedQaUrl(hostedQaUrl);
  const parsed = parseUrl(value, "Vercel Preview share URL", issues, ["https:"]);

  if (!hostedResult.ok) {
    issues.push(...hostedResult.issues.map((issue) => `Hosted QA target: ${issue}`));
  }
  rejectDenied(value, "Vercel Preview share URL", issues);

  if (parsed) {
    const approvedOrigin = hostedResult.url?.origin;
    if (!approvedOrigin || parsed.origin !== approvedOrigin) {
      issues.push("Vercel Preview share URL must use the exact approved Hosted QA origin.");
    }
    if (parsed.pathname !== "/" || parsed.hash) {
      issues.push("Vercel Preview share URL must use the origin root without a fragment.");
    }
    if (parsed.username || parsed.password || (parsed.port && parsed.port !== "443")) {
      issues.push("Vercel Preview share URL must not embed credentials or a non-default port.");
    }
    const entries = [...parsed.searchParams.entries()];
    if (entries.length !== 1 || entries[0]?.[0] !== "_vercel_share" || !entries[0]?.[1]) {
      issues.push("Vercel Preview share URL must contain only a non-empty _vercel_share token.");
    }
  }

  if (issues.length) return { ok: false, issues };
  return { ok: true, url: parsed };
}

export function assertApprovedVercelShareUrl(value, hostedQaUrl) {
  const result = validateApprovedVercelShareUrl(value, hostedQaUrl);
  if (!result.ok) throw new ProductionBoundaryError(result.issues);
  if (!result.url) throw new ProductionBoundaryError(["Vercel Preview share URL is required."]);
  return result.url;
}

export function assertSafeGitBranch(branch) {
  const value = text(branch);
  if (!value || FORBIDDEN_BRANCH.test(value)) {
    throw new ProductionBoundaryError([
      "A non-Production branch identity is required; main/master/prod/production are denied.",
    ]);
  }
  return value;
}

/** Reject inherited hosted credentials/settings rather than silently masking them. */
export function assertPublicationEnvironment(env) {
 for (const [key,value] of Object.entries(env)) {
  if (!value) continue;
  if (/^NEXT_PUBLIC_.*(SERVICE_ROLE|SECRET_KEY|DATABASE_PASSWORD|JWT_SECRET)/i.test(key)) throw new ProductionBoundaryError(['Privileged frontend configuration is disabled.']);
  if (/^(VERCEL_ENV|VERCEL_PROJECT_ID|SUPABASE_SERVICE_ROLE_KEY|SUPABASE_SECRET_KEY|DATABASE_URL|SUPABASE_DB_URL)$/.test(key)) throw new ProductionBoundaryError(['Hosted/service configuration is disabled in the publication copy.']);
  if (key === 'NEXT_PUBLIC_SUPABASE_URL' && value !== 'https://demo.invalid') throw new ProductionBoundaryError(['Only the offline demo URL is accepted.']);
 }
 return true;
}
