import {
  MAX_CSP_REPORT_BYTES,
  sanitizeCspReports,
} from "@/lib/csp-report";

export const dynamic = "force-dynamic";

const ALLOWED_CONTENT_TYPES = new Set([
  "application/csp-report",
  "application/json",
  "application/reports+json",
]);

function response(status: number) {
  return new Response(null, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (!contentType || !ALLOWED_CONTENT_TYPES.has(contentType)) return response(415);

  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CSP_REPORT_BYTES) {
    return response(413);
  }

  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_CSP_REPORT_BYTES) return response(413);

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return response(400);
  }

  for (const report of sanitizeCspReports(payload)) {
    console.warn("CSP_REPORT", JSON.stringify(report));
  }

  return response(204);
}
