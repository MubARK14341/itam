import { Sidebar } from "@/components/sidebar";
import { AppTopbar } from "@/components/app-topbar";
import { AppContentBoundary } from "@/components/app-content-boundary";
import { EmployeeTabbar } from "@/components/shell/employee-tabbar";
import { SessionProvider } from "@/lib/session";
import { headers } from "next/headers";
import { getInitialSessionIdentity } from "@/lib/session-server";
import { decodeInitialContext, INITIAL_CONTEXT_HEADER } from "@/lib/initial-context-header";
import { ApprovalGuard } from "@/components/providers/approval-guard";
import { FeatureExposureProvider } from "@/components/providers/feature-exposure-provider";
import { SchemaCompatibilityGate } from "@/components/schema-compatibility-gate";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // Resolved next to the database so the shell renders without the browser's identity round trips.
  // Prefer the identity the middleware verified moments ago; otherwise resolve it here.
  const handedOff = decodeInitialContext((await headers()).get(INITIAL_CONTEXT_HEADER))?.session;
  const initialSession = handedOff ?? await getInitialSessionIdentity();
  return (
    <SchemaCompatibilityGate>
      <SessionProvider initial={initialSession}>
        <ApprovalGuard>
          <FeatureExposureProvider initialSettings={initialSession?.exposure ?? null}>
            <div className="app-shell flex h-dvh overflow-hidden">
              <Sidebar />
              <main className="app-main flex min-w-0 flex-1 flex-col overflow-y-auto">
                <AppTopbar />
                {/* حاوية أوسع على الشاشات الكبيرة لاستغلال المساحة الأفقية مع الحفاظ على القراءة وسلامة الجوال */}
                {/* مساحة سفلية تحت md لشريط التبويب السفلي للموظف */}
                <div className="app-content mx-auto w-full min-w-0 max-w-[1600px] px-4 pb-24 pt-6 sm:px-6 md:pb-8 lg:px-8 lg:pt-7"><AppContentBoundary>{children}</AppContentBoundary></div>
              </main>
              <EmployeeTabbar />
            </div>
          </FeatureExposureProvider>
        </ApprovalGuard>
      </SessionProvider>
    </SchemaCompatibilityGate>
  );
}
