"use client";

import { useRef } from "react";
import { seedReadPrefetch, type ReadSeed as ReadSeedPayload } from "@/lib/supabase/read-prefetch";

/**
 * Hands the reads a server page recorded (lib/supabase/server-read-seed.ts) to the page rendered
 * after it. Applied during render, so the seed is in place before any effect of the page runs.
 */
export function ReadSeed({ seed }: { seed: ReadSeedPayload | null }) {
  const applied = useRef<string | null>(null);
  if (seed && applied.current !== seed.id) {
    applied.current = seed.id;
    seedReadPrefetch(seed);
  }
  return null;
}
