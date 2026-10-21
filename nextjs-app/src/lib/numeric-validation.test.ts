import { describe, expect, it } from "vitest";
import { parseStrictDecimal, parseStrictInteger } from "./numeric-validation";

describe("strict numeric input validation", () => {
  it("accepts bounded base-10 integers and intentional empty defaults", () => {
    expect(parseStrictInteger("42", { min: 1 })).toEqual({ ok: true, value: 42 });
    expect(parseStrictInteger("", { emptyValue: 0 })).toEqual({ ok: true, value: 0 });
  });

  it.each(["Infinity", "NaN", "1e3", "0x10", "-1", "1.5", "01"])(
    "rejects ambiguous or unsafe integer input %s",
    (value) => expect(parseStrictInteger(value)).toMatchObject({ ok: false }),
  );

  it("requires positive movement quantities", () => {
    expect(parseStrictInteger("", { required: true, min: 1 })).toMatchObject({ ok: false });
    expect(parseStrictInteger("0", { required: true, min: 1 })).toMatchObject({ ok: false });
    expect(parseStrictInteger("2147483648")).toMatchObject({ ok: false });
  });

  it.each(["12.50", ".75", "0", "1000000"])("accepts bounded decimal input %s", (value) => {
    expect(parseStrictDecimal(value)).toMatchObject({ ok: true });
  });

  it.each(["", "Infinity", "NaN", "1e308", "0x20", "-0.01", "1,000"])(
    "rejects invalid required decimal input %s",
    (value) => expect(parseStrictDecimal(value, { required: true })).toMatchObject({ ok: false }),
  );
});
