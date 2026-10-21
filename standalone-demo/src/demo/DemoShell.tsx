import type { ReactNode } from 'react';
import { Sidebar } from '@/components/sidebar';
import { AppTopbar } from '@/components/app-topbar';
import { AppContentBoundary } from '@/components/app-content-boundary';
import { EmployeeTabbar } from '@/components/shell/employee-tabbar';
import { ApprovalGuard } from '@/components/providers/approval-guard';
import { FeatureExposureProvider } from '@/components/providers/feature-exposure-provider';
import ClientPortalLayout from '../studio/app/(portal)/client-portal/layout';
import { DemoSession } from './DemoSession';

export function DemoShell({ surface, children }: { surface: 'staff' | 'portal'; children: ReactNode }) {
  if (surface === 'portal') return <ClientPortalLayout>{children}</ClientPortalLayout>;
  return <DemoSession><ApprovalGuard><FeatureExposureProvider>
    <div className="app-shell flex h-dvh overflow-hidden">
      <Sidebar />
      <main className="app-main flex min-w-0 flex-1 flex-col overflow-y-auto">
        <AppTopbar />
        <div className="app-content mx-auto w-full min-w-0 max-w-[1600px] px-4 pb-24 pt-6 sm:px-6 md:pb-8 lg:px-8 lg:pt-7"><AppContentBoundary>{children}</AppContentBoundary></div>
      </main>
      <EmployeeTabbar />
    </div>
  </FeatureExposureProvider></ApprovalGuard></DemoSession>;
}
