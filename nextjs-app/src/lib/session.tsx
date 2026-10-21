"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { reportOperationalFailure } from "@/lib/observability";
import {
  getAuthSecurityState,
  getStaffAccessState,
  secureSignOut,
  sessionExpiryAt,
  type AuthSecurityState,
  type StaffAccessState,
} from "@/lib/auth-security";

export type { Role, ApprovalStatus } from "@/lib/staff-access";
// Pure role rules live in staff-access.ts so server pages can apply the same rules.
export { resolveStaffAccess, canSeeFinancial, canManageSettings } from "@/lib/staff-access";
import { resolveStaffAccess, canSeeFinancial, type Role, type ApprovalStatus } from "@/lib/staff-access";

export const ROLE_AR: Record<string, string> = {
  admin: "مدير",
  it_manager: "مدير تقنية المعلومات",
  technician: "تقنية",
  warehouse_manager: "مستودع",
  auditor: "مدقّق",
  viewer: "مشاهد",
  employee: "موظف",
};

export function canWrite(role: Role) {
  return role === "admin" || role === "it_manager" || role === "technician" || role === "warehouse_manager";
}
// إنشاء/تعديل الأصول الفردية = admin/it_manager فقط (قرار UAT: technician ممنوع من إنشاء الأصول).
// طبقة إخفاء واجهة فقط — الحاكم الفعلي RLS (سياسة ins_ops على public.assets)؛ إخفاء الواجهة لا يُغلق
// مسار الإدراج المباشر من العميل، لذا يبقى الإصلاح الأمني الحقيقي على مستوى RLS (بانتظار موافقة).
export function canCreateAsset(role: Role) {
  return role === "admin" || role === "it_manager";
}
// كتابة سجلات الأصول القائمة (تعديل/مرفقات/صيانة مرتبطة) تطابق سياسات assets التشغيلية.
export function canManageAssets(role: Role) {
  return role === "admin" || role === "it_manager" || role === "technician";
}
// تعديل سجلات الأصول والكتالوجات يتم مباشرةً عبر الجداول، لذلك يقتصر على
// المدير ومدير تقنية المعلومات؛ الفني يحتفظ فقط بمساراته التشغيلية عبر RPC.
export function canManageAssetRecords(role: Role) {
  return role === "admin" || role === "it_manager";
}
export function canManageMaintenance(role: Role) {
  return canManageAssets(role) || role === "warehouse_manager";
}
export function canManageConsumables(role: Role) {
  return canManageAssets(role);
}
export function canManageConsumableCatalog(role: Role) {
  return canManageAssetRecords(role);
}
export function canManagePurchaseRequests(role: Role) {
  return canManageAssets(role);
}
export function canManageActionCenter(role: Role) {
  return canManageAssets(role) || role === "warehouse_manager";
}
// سياسات Storage الحالية لمرفقات الطلبات لا تشمل warehouse_manager؛ نخفي الكتابة مع إبقاء القراءة.
export function canManageRequestAttachments(role: Role) {
  return canManageAssets(role);
}
export function canUseScan(role: Role) {
  return role === "admin" || role === "it_manager" || role === "technician" || role === "warehouse_manager";
}
// دور تشغيل المستودع (تجهيز/تسليم/إرجاع/فحص). يشمل الأدوار التي تنفّذ عمليات المستودع.
export function isWarehouseOps(role: Role) {
  return role === "admin" || role === "it_manager" || role === "technician" || role === "warehouse_manager";
}
export function isAdmin(role: Role) {
  return role === "admin";
}

// عرض/إدخال تكلفة الصيانة على مستوى السجل الواحد.
// HIGH-1 (Strict): التكلفة مالية بالكامل — admin/it_manager فقط (technician لا يقرأ ولا يُدخل).
// مطابق لحجب maintenance_records.cost على مستوى العمود في قاعدة البيانات.
export function canSeeMaintenanceCost(role: Role) {
  return canSeeFinancial(role);
}

// إدارة الموردين تتم من الإعدادات فقط، لنفس الأدوار.
export function canManageSuppliers(role: Role) {
  return role === "admin" || role === "it_manager";
}

// capabilities: قائمة مفاتيح القدرات الفعّالة للمستخدم (من RPC my_capabilities). admin يحصل على الكل.
// طبقة إخفاء واجهة فقط — RLS/RPC يبقى الحاكم الفعلي (has_capability في القاعدة).
interface SessionValue { userId: string | null; email: string | null; role: Role; approvalStatus: ApprovalStatus; capabilities: string[]; loading: boolean; }
// fail-closed: الحالة الافتراضية آمنة (غير معتمد، بلا دور فعّال) حتى تُثبت الجلسة العكس.
// محتوى التطبيق لا يظهر أثناء loading أصلًا، لكن نُبقي القيم محجوبة تحسّبًا لأي استهلاك مبكر.
const Ctx = createContext<SessionValue>({ userId: null, email: null, role: null, approvalStatus: "pending", capabilities: [], loading: true });

// حالة محجوبة آمنة: تُستخدم عند غياب الجلسة أو فشل قراءة سجل المستخدم/الموافقة.
const blocked = (email: string | null): SessionValue => ({ userId: null, email, role: null, approvalStatus: "pending", capabilities: [], loading: false });

export function SessionProvider({
  children,
  initial = null,
}: {
  children: React.ReactNode;
  /** Server-resolved identity (see session-server.ts); when absent the provider loads it itself. */
  initial?: { userId: string; email: string | null; role: Role; approvalStatus: ApprovalStatus; capabilities: string[] } | null;
}) {
  const hasInitial = initial != null;
  const [value, setValue] = useState<SessionValue>(initial
    ? { ...initial, loading: false }
    : { userId: null, email: null, role: null, approvalStatus: "pending", capabilities: [], loading: true });

  useEffect(() => {
    // Identity already verified server-side for this document; the security monitor below still runs.
    if (hasInitial) return;
    let active = true;
    (async () => {
      try {
        const sb = createClient();
        const { data: { user }, error: authError } = await sb.auth.getUser();
        // بلا جلسة أو فشل التحقق: نحجب — الـ middleware يتكفّل بالتوجيه إلى /login.
        if (authError || !user) {
          if (authError) reportOperationalFailure("session_auth_load_failed", authError);
          if (active) setValue(blocked(null));
          return;
        }
        // استخدم نفس هوية التوجيه المباشرة التي يعتمدها middleware. هذا يمنع اختلاف
        // التوجيه بسبب علاقة roles المضمّنة والمحميّة بـ RLS.
        // القدرات تُطلب مع حالة الموظف في نفس الموجة (بعد التحقق من المستخدم) بدل موجة ثالثة.
        const capabilitiesRequest = Promise.resolve(sb.rpc("my_capabilities"))
          .then((result) => ({ result, thrown: null as unknown }))
          .catch((thrown: unknown) => ({ result: null, thrown }));
        const identity = resolveStaffAccess(await getStaffAccessState(sb, user.id));
        // فشل القراءة أو غياب هوية موظف صالحة: fail-closed — لا نفترض approved/viewer.
        if (!identity) {
          reportOperationalFailure("session_security_state_load_failed", new Error("invalid_staff_security_state"));
          if (active) setValue(blocked(user.email ?? null));
          return;
        }
        // القدرات الفعّالة (تجاوزات المستخدم + افتراضي الدور) — للإخفاء في الواجهة فقط.
        let capabilities: string[] = [];
        const { result: capabilitiesResult, thrown: capabilitiesThrown } = await capabilitiesRequest;
        if (capabilitiesThrown) {
          reportOperationalFailure("session_capabilities_load_failed", capabilitiesThrown);
        } else if (capabilitiesResult) {
          const { data: caps, error: capabilitiesError } = capabilitiesResult;
          if (capabilitiesError) {
            reportOperationalFailure("session_capabilities_load_failed", capabilitiesError);
          }
          if (Array.isArray(caps)) capabilities = caps as string[];
        }
        if (active) setValue({
          userId: user.id,
          email: user.email ?? null,
          role: identity.role,
          approvalStatus: identity.approvalStatus,
          capabilities,
          loading: false,
        });
      } catch (sessionError) {
        // أي خطأ غير متوقع (شبكة/عميل): fail-closed.
        reportOperationalFailure("session_load_failed", sessionError);
        if (active) setValue(blocked(null));
      }
    })();
    return () => { active = false; };
  }, [hasInitial]);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastActivityMs = Date.now();
    let security: AuthSecurityState | null = null;
    let signedInAtMs = Date.now();
    const client = createClient();

    const expire = async () => {
      if (!active) return;
      active = false;
      await secureSignOut(client, "session_expired");
      window.location.replace("/login?reason=session_expired");
    };

    const schedule = () => {
      if (!active || !security) return;
      if (timer) clearTimeout(timer);
      const deadline = sessionExpiryAt({
        nowMs: Date.now(),
        lastActivityMs,
        signedInAtMs,
        idleSeconds: security.session_idle_seconds,
        absoluteSeconds: security.session_absolute_seconds,
      });
      timer = setTimeout(() => { void expire(); }, Math.max(0, deadline - Date.now()));
    };

    const activity = () => {
      const now = Date.now();
      if (now - lastActivityMs < 30_000) return;
      lastActivityMs = now;
      schedule();
    };

    (async () => {
      const [{ data }, state] = await Promise.all([
        client.auth.getSession(),
        getAuthSecurityState(client),
      ]);
      if (!active || !data.session || !state) return;
      security = state;
      const parsed = Date.parse(data.session.user.last_sign_in_at ?? "");
      signedInAtMs = Number.isFinite(parsed) ? parsed : Date.now();
      if (state.needs_mfa && window.location.pathname !== "/auth/mfa") {
        window.location.replace("/auth/mfa");
        return;
      }
      schedule();
      for (const event of ["pointerdown", "keydown", "touchstart"] as const) {
        window.addEventListener(event, activity, { passive: true });
      }
    })().catch((error) => reportOperationalFailure("session_security_monitor_failed", error));

    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      for (const event of ["pointerdown", "keydown", "touchstart"] as const) {
        window.removeEventListener(event, activity);
      }
    };
  }, []);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession() { return useContext(Ctx); }

// hook مريح لفحص القدرة في الواجهة: const can = useCan(); can("report.export").
// طبقة إخفاء فقط — الحارس الفعلي RLS/RPC (has_capability). القائمة الفارغة تُخفي (fail-closed).
export function useCan() {
  const { capabilities } = useContext(Ctx);
  return (key: string) => capabilities.includes(key);
}
