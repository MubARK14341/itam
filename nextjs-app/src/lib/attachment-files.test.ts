import { describe, expect, it } from "vitest";
import {
  inferAttachmentMime,
  validateAttachmentContent,
  validateAttachmentFile,
} from "./attachment-files";

function file(
  name: string,
  type: string,
  bytes: Uint8Array | string,
): File {
  const content: BlobPart = typeof bytes === "string"
    ? bytes
    : new Uint8Array(bytes).buffer;
  return new File([content], name, { type });
}

describe("attachment byte validation", () => {
  it.each([
    ["report.pdf", "application/pdf", new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31])],
    ["photo.png", "image/png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ["photo.jpg", "image/jpeg", new Uint8Array([0xff, 0xd8, 0xff, 0xe0])],
    ["photo.webp", "image/webp", "RIFF0000WEBP"],
    [
      "legacy.doc",
      "application/msword",
      new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    ],
    [
      "document.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "PK\u0003\u0004word/document.xml [Content_Types].xml",
    ],
  ])("accepts a valid %s signature", async (name, type, bytes) => {
    expect(await validateAttachmentContent(file(name, type, bytes))).toBeNull();
  });

  it.each([
    ["payload.pdf", "application/pdf", "<html><script>alert(1)</script></html>"],
    ["vector.png", "image/png", "<svg onload='alert(1)'></svg>"],
    ["program.pdf", "application/pdf", new Uint8Array([0x4d, 0x5a, 0x90, 0x00])],
    ["archive.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "PK\u0003\u0004not-office"],
  ])("rejects spoofed active content in %s", async (name, type, bytes) => {
    expect(await validateAttachmentContent(file(name, type, bytes))).toBe("content_mismatch");
  });

  it("requires the declared MIME to match the allowlisted extension", () => {
    const mismatched = file(
      "renamed.pdf",
      "image/png",
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(validateAttachmentFile(mismatched)).toBe("bad_type");
    expect(inferAttachmentMime(mismatched)).toBe("application/pdf");
  });
});
