import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";
import { isPublicPath } from "@/lib/public-routes";
import { ROUTE_PATHNAME_HEADER } from "@/lib/route-title";
import { INITIAL_CONTEXT_HEADER } from "@/lib/initial-context-header";

export async function middleware(request: NextRequest) {
  const requestHeaders = new Headers(request.headers);
  // Never accept the internal identity hand-off header from the outside.
  requestHeaders.delete(INITIAL_CONTEXT_HEADER);
  requestHeaders.set(ROUTE_PATHNAME_HEADER, request.nextUrl.pathname);
  if (isPublicPath(request.nextUrl.pathname)) {
    return NextResponse.next({ request: { headers: requestHeaders } });
  }
  // كل ما تبقّى محمي: بدون جلسة → /login
  return await updateSession(request, requestHeaders);
}

export const config = {
  runtime: "nodejs",
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
