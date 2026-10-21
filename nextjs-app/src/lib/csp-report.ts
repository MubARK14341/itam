export const MAX_CSP_REPORT_BYTES = 16 * 1024;
export const MAX_CSP_REPORTS_PER_REQUEST = 20;

export type SanitizedCspReport = {
  blockedUrl: string | null;
  columnNumber: number | null;
  documentUrl: string | null;
  effectiveDirective: string | null;
  lineNumber: number | null;
  sourceFile: string | null;
  statusCode: number | null;
  violatedDirective: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function limitedString(value: unknown, maxLength = 160): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized) return null;
  return normalized.slice(0, maxLength);
}

function safeNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.trunc(value));
}

function sanitizedUrl(value: unknown): string | null {
  const input = limitedString(value, 2048);
  if (!input) return null;
  if (["inline", "eval", "self", "none"].includes(input)) return input;

  try {
    const parsed = new URL(input);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return `${parsed.origin}${parsed.pathname}`.slice(0, 320);
    }
    return parsed.protocol.slice(0, 24);
  } catch {
    return limitedString(input);
  }
}

function first(record: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

function sanitizeOne(value: unknown): SanitizedCspReport | null {
  if (!isRecord(value)) return null;
  const legacy = value["csp-report"];
  const reportBody = isRecord(value.body) ? value.body : null;
  const report = isRecord(legacy) ? legacy : reportBody ?? value;

  const effectiveDirective = limitedString(
    first(report, "effective-directive", "effectiveDirective"),
  );
  const violatedDirective = limitedString(
    first(report, "violated-directive", "violatedDirective"),
  );

  if (!effectiveDirective && !violatedDirective) return null;

  return {
    blockedUrl: sanitizedUrl(first(report, "blocked-uri", "blockedURL")),
    columnNumber: safeNumber(first(report, "column-number", "columnNumber")),
    documentUrl: sanitizedUrl(first(report, "document-uri", "documentURL")),
    effectiveDirective,
    lineNumber: safeNumber(first(report, "line-number", "lineNumber")),
    sourceFile: sanitizedUrl(first(report, "source-file", "sourceFile")),
    statusCode: safeNumber(first(report, "status-code", "statusCode")),
    violatedDirective,
  };
}

export function sanitizeCspReports(payload: unknown): SanitizedCspReport[] {
  const candidates = Array.isArray(payload) ? payload : [payload];
  return candidates
    .slice(0, MAX_CSP_REPORTS_PER_REQUEST)
    .map(sanitizeOne)
    .filter((report): report is SanitizedCspReport => report !== null);
}
