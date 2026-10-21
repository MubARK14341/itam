export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export const ALLOWED_ATTACHMENT_MIME = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
] as const;

const EXTENSION_MIME: Readonly<Record<string, string>> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

export type AttachmentFileValidation =
  | "bad_type"
  | "too_large"
  | "content_mismatch"
  | null;

function extensionOf(name: string): string {
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index + 1).toLowerCase() : "";
}

export function inferAttachmentMime(file: File): string {
  const fromExtension = EXTENSION_MIME[extensionOf(file.name)];
  return fromExtension || file.type || "application/octet-stream";
}

export function validateAttachmentFile(file: File): AttachmentFileValidation {
  const expectedMime = EXTENSION_MIME[extensionOf(file.name)];
  if (!expectedMime) return "bad_type";
  if (
    file.type
    && (
      !(ALLOWED_ATTACHMENT_MIME as readonly string[]).includes(file.type)
      || file.type !== expectedMime
    )
  ) return "bad_type";
  if (file.size <= 0 || file.size > MAX_ATTACHMENT_BYTES) return "too_large";
  return null;
}

function startsWithBytes(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function containsAscii(bytes: Uint8Array, value: string): boolean {
  const needle = new TextEncoder().encode(value);
  outer: for (let offset = 0; offset <= bytes.length - needle.length; offset += 1) {
    for (let index = 0; index < needle.length; index += 1) {
      if (bytes[offset + index] !== needle[index]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * Browser-side defense in depth. Storage policies still quarantine every new
 * object until a trusted service records a clean scanner verdict; this check
 * prevents obvious MIME/extension spoofing before bytes leave the browser.
 */
export async function validateAttachmentContent(
  file: File,
): Promise<AttachmentFileValidation> {
  const structural = validateAttachmentFile(file);
  if (structural) return structural;

  const bytes = new Uint8Array(await file.arrayBuffer());
  const extension = extensionOf(file.name);
  let matches = false;

  switch (extension) {
    case "pdf":
      matches = startsWithBytes(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]);
      break;
    case "png":
      matches = startsWithBytes(
        bytes,
        [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      );
      break;
    case "jpg":
    case "jpeg":
      matches = startsWithBytes(bytes, [0xff, 0xd8, 0xff]);
      break;
    case "webp":
      matches = startsWithBytes(bytes, [0x52, 0x49, 0x46, 0x46])
        && bytes[8] === 0x57
        && bytes[9] === 0x45
        && bytes[10] === 0x42
        && bytes[11] === 0x50;
      break;
    case "doc":
      matches = startsWithBytes(
        bytes,
        [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],
      );
      break;
    case "docx":
      matches = startsWithBytes(bytes, [0x50, 0x4b, 0x03, 0x04])
        && containsAscii(bytes, "[Content_Types].xml")
        && containsAscii(bytes, "word/");
      break;
  }

  return matches ? null : "content_mismatch";
}

export function sanitizeAttachmentFileName(name: string): string {
  const dot = name.lastIndexOf(".");
  const extension = dot > 0
    ? name.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 10)
    : "";
  let base = (dot > 0 ? name.slice(0, dot) : name)
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 80);
  if (!base) base = "file";
  return extension ? `${base}.${extension}` : base;
}

export function buildAttachmentObjectName(
  root: "assets" | "consumables" | "maintenance",
  entityId: string,
  subtype: string,
  originalName: string,
): string {
  const safeSubtype = subtype.replace(/[^a-z0-9_-]/gi, "").slice(0, 40);
  const unique = globalThis.crypto.randomUUID();
  return `${root}/${entityId}/${safeSubtype}/${unique}_${sanitizeAttachmentFileName(originalName)}`;
}
