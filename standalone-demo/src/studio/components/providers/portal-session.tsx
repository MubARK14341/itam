"use client";

import { createContext, useContext } from "react";
import type { PortalContext } from "@/lib/portal";

// سياق جلسة بوابة العميل — منفصل تمامًا عن SessionProvider الداخلي.
// (منفصل عن layout.tsx لأن Next.js يمنع التصديرات المخصّصة من ملفات layout.)
const Ctx = createContext<PortalContext | null>(null);

export const PortalSessionProvider = Ctx.Provider;

export function usePortalSession(): PortalContext | null {
  return useContext(Ctx);
}
