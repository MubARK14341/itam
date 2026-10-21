import { describe, it, expect } from "vitest";
import { safeHttpUrl } from "./safe-url";

describe("safeHttpUrl", () => {
  it("allows http and https", () => {
    expect(safeHttpUrl("https://maps.google.com/place")).toBe("https://maps.google.com/place");
    expect(safeHttpUrl("http://example.com/")).toBe("http://example.com/");
  });

  it("blocks dangerous schemes (XSS)", () => {
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("JavaScript:alert(document.cookie)")).toBeNull();
    expect(safeHttpUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(safeHttpUrl("vbscript:msgbox(1)")).toBeNull();
    expect(safeHttpUrl("file:///etc/passwd")).toBeNull();
  });

  it("rejects empty, nullish, and scheme-less input", () => {
    expect(safeHttpUrl(null)).toBeNull();
    expect(safeHttpUrl(undefined)).toBeNull();
    expect(safeHttpUrl("   ")).toBeNull();
    expect(safeHttpUrl("maps.google.com/x")).toBeNull();
  });
});
