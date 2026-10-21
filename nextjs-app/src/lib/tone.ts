// Ledger status tones: every status/priority/stage maps to exactly one of six tones,
// rendered as a chip with a dot + text (never colour alone). Classes live in globals.css.
import type { AssetStatus } from "./types";

export type Tone = "ok" | "res" | "warn" | "bad" | "info" | "neu";

export const TONES: readonly Tone[] = ["ok", "res", "warn", "bad", "info", "neu"];

export function toneChipClass(tone: Tone | null | undefined): string {
  return `tone-${tone && TONES.includes(tone) ? tone : "neu"}`;
}

/** Text-only tone colour (icons, counters). */
export const TONE_TEXT: Record<Tone, string> = {
  ok: "text-ok", res: "text-res", warn: "text-warn", bad: "text-bad", info: "text-brand-ink", neu: "text-muted",
};

export function toneStyles<K extends string>(map: Record<K, Tone>): Record<K, string> {
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, toneChipClass(v as Tone)])) as Record<K, string>;
}

export const ASSET_STATUS_TONE: Record<AssetStatus, Tone> = {
  available: "ok",
  reserved: "res",
  in_maintenance: "warn",
};

export const REQUEST_STATUS_TONE: Record<string, Tone> = {
  draft: "neu",
  under_review: "info",
  needs_clarification: "warn",
  approved: "info",
  rejected: "neu",
  auto_provisioning: "res",
  provisioned: "res",
  stock_shortage: "warn",
  awaiting_supply: "warn",
  preparing: "res",
  ready_for_pickup: "ok",
  delivered: "neu",
  partially_returned: "warn",
  returned: "ok",
  completed: "ok",
  cancelled: "neu",
  overdue: "bad",
};

export const PRIORITY_TONE: Record<string, Tone> = { low: "neu", medium: "info", high: "warn", critical: "bad" };

export const STAGE_TONE: Record<string, Tone> = {
  open: "neu", investigating: "info", awaiting_parts: "warn", at_vendor: "res", completed: "ok", unrepairable: "bad",
};

export const MAINT_STATUS_TONE: Record<string, Tone> = {
  open: "warn", in_progress: "info", completed: "ok", cancelled: "neu",
};
