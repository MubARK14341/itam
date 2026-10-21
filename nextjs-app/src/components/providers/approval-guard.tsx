"use client";

import { useEffect } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { getPortalContext } from "@/lib/portal";
import { useSession } from "@/lib/session";
import { canAccessInternalPath, defaultInternalLanding } from "@/lib/user-facing-role";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";

/**
 * حارس الموافقة — يمنع المستخدمين غير المعتمدين (pending/rejected) من رؤية أي صفحة داخلية.
 * الحاجز الفعلي هو RLS (لا يقرؤون بيانات النظام أصلًا)؛ هذا الحارس للتوجيه وتجربة المستخدم فقط.
 * يوجّه إلى /pending-approval التي تقع خارج مجموعة (app) فلا تخضع لهذا الحارس.
 */
export function ApprovalGuard({ children }: { children: React.ReactNode }) {
  const { approvalStatus, loading, role } = useSession();
  const { t } = useAppPreferences();
  const router = useRouter();
  const pathname = usePathname();
  const allowedPath = canAccessInternalPath(role, pathname);

  useEffect(() => {
    if (loading || approvalStatus === "approved") return;
    let cancelled = false;
    void getPortalContext().then((portal) => {
      if (!cancelled) {
        router.replace(portal ? "/client-portal" : "/pending-approval");
      }
    });
    return () => { cancelled = true; };
  }, [loading, approvalStatus, router]);

  useEffect(() => {
    if (loading || approvalStatus !== "approved" || allowedPath) return;
    // A direct restricted URL can render this guard before Next finishes a
    // client transition. Use replace at the browser boundary so the user never
    // remains on an intentionally blank protected shell.
    window.location.replace(defaultInternalLanding(role));
  }, [allowedPath, approvalStatus, loading, pathname, role, router]);

  // Do not expose protected content while the session resolves, but also do
  // not leave a direct protected URL looking broken during that short wait.
  if (loading) {
    return (
      <section className="mx-auto max-w-lg rounded-card border border-line bg-surface p-6 text-center" role="status" aria-live="polite">
        <p className="text-sm text-fg-2">{t.common.loading}</p>
      </section>
    );
  }
  if (approvalStatus !== "approved") return null;
  if (!allowedPath) {
    const landing = defaultInternalLanding(role);
    return (
      <section className="mx-auto max-w-lg rounded-card border border-warn/30 bg-warn-soft p-6 text-center" role="alert">
        <h1 className="font-display text-lg font-semibold text-fg">{t.common.notAuthorized}</h1>
        <p className="mt-2 text-sm text-fg-2">{t.common.accessRestricted}</p>
        <Link href={landing} prefetch={false} className="ui-button ui-button-primary ui-button-md mt-4">
          {t.common.returnToWorkspace}
        </Link>
      </section>
    );
  }
  return <>{children}</>;
}
