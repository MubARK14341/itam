"use client";

import { createContext, useContext } from "react";
import type { PortalContext } from "@/lib/portal";

// Server-resolved portal context for the current document (null ⇒ the portal layout loads it itself).
const InitialPortalCtx = createContext<PortalContext | null>(null);

export function InitialPortalContextProvider({ value, children }: { value: PortalContext | null; children: React.ReactNode }) {
  return <InitialPortalCtx.Provider value={value}>{children}</InitialPortalCtx.Provider>;
}

export function useInitialPortalContext() {
  return useContext(InitialPortalCtx);
}
