import { describe, expect, it } from "vitest";
import {
  ASSET_STATUS_TONE, MAINT_STATUS_TONE, PRIORITY_TONE, REQUEST_STATUS_TONE, STAGE_TONE, TONES, toneChipClass,
} from "./tone";
import { PORTAL_FULFILLMENT_TONE, PORTAL_STATUS_TONE, PORTAL_STATUS_STYLE } from "./portal-status";
import { REQUEST_STATUS_STYLE, STATUS_STYLE } from "./format";
import { MAINT_STATUS_STYLE, PRIORITY_STYLE, STAGE_STYLE } from "./maintenance";
import { rawRequestStatusesForDisplay, simplifiedRequestStatus } from "./request-fulfillment";
import { en } from "./translations/en";
import type { RequestStatus } from "./requests";

const REQUEST_STATUSES: RequestStatus[] = [
  "draft", "under_review", "needs_clarification", "approved", "rejected",
  "auto_provisioning", "provisioned", "stock_shortage", "preparing",
  "ready_for_pickup", "delivered", "partially_returned", "returned",
  "completed", "cancelled", "overdue",
];

describe("Ledger status tones", () => {
  it("maps any tone to exactly one chip class and falls back to neutral", () => {
    for (const tone of TONES) expect(toneChipClass(tone)).toBe(`tone-${tone}`);
    expect(toneChipClass(null)).toBe("tone-neu");
    expect(toneChipClass("nope" as never)).toBe("tone-neu");
  });

  it("gives every raw and displayed request status a tone", () => {
    for (const status of REQUEST_STATUSES) {
      expect(TONES).toContain(REQUEST_STATUS_TONE[status]);
      expect(TONES).toContain(REQUEST_STATUS_TONE[simplifiedRequestStatus(status)]);
    }
    for (const display of Object.keys(en.requestStatus)) {
      if (rawRequestStatusesForDisplay(display as never).length === 0) continue;
      expect(TONES).toContain(REQUEST_STATUS_TONE[display]);
    }
  });

  it("covers every labelled asset, maintenance and portal value", () => {
    expect(Object.keys(ASSET_STATUS_TONE).sort()).toEqual(Object.keys(en.status).sort());
    expect(Object.keys(PRIORITY_TONE).sort()).toEqual(Object.keys(en.priority).sort());
    expect(Object.keys(STAGE_TONE).sort()).toEqual(Object.keys(en.stage).sort());
    expect(Object.keys(MAINT_STATUS_TONE).sort()).toEqual(Object.keys(en.maintStatus).sort());
    expect(Object.keys(PORTAL_STATUS_TONE).sort()).toEqual(Object.keys(en.portal.status).sort());
    expect(Object.keys(PORTAL_FULFILLMENT_TONE).sort()).toEqual(Object.keys(en.portal.fulfillment).sort());
  });

  it("keeps the legacy *_STYLE maps as tone chip classes", () => {
    const maps = [STATUS_STYLE, REQUEST_STATUS_STYLE, PRIORITY_STYLE, STAGE_STYLE, MAINT_STATUS_STYLE, PORTAL_STATUS_STYLE];
    for (const map of maps) {
      for (const value of Object.values(map)) expect(value).toMatch(/^tone-(ok|res|warn|bad|info|neu)$/);
    }
  });

  it("uses the Ledger semantic colours for the core asset states", () => {
    expect(ASSET_STATUS_TONE).toEqual({ available: "ok", reserved: "res", in_maintenance: "warn" });
    expect(REQUEST_STATUS_TONE.overdue).toBe("bad");
    expect(PRIORITY_TONE.critical).toBe("bad");
  });
});
