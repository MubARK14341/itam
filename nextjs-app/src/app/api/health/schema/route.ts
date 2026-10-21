import { NextResponse } from "next/server";
import { checkSchemaCompatibility } from "@/lib/schema-compatibility";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createClient();
  const result = await checkSchemaCompatibility(supabase);
  return NextResponse.json(
    {
      status: result.ok ? "ok" : "incompatible",
      expectedVersion: result.expectedVersion,
      actualVersion: result.actualVersion,
      reason: result.reason,
      missing: result.missing,
    },
    {
      status: result.ok ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
