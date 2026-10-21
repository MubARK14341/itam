import { describe, expect, it } from "vitest";
import { ASSET_POOLS_UI_VISIBLE } from "./asset-pools-visibility";

describe("Asset Pools UI policy", () => {
  it("keeps the unfinished internal pool UI hidden without deleting its data path", () => {
    expect(ASSET_POOLS_UI_VISIBLE).toBe(false);
  });
});
