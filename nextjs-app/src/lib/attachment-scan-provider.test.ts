import { describe, expect, it } from "vitest";
import {
  AttachmentScanProviderError,
  createTestAttachmentScanProvider,
  executeAttachmentScan,
  type AttachmentScanAuditEvent,
} from "./attachment-scan-provider";

const job = {
  jobId: "job-1",
  attachmentReference: "attachment-1",
  bucket: "itam-attachments",
  objectPath: "assets/synthetic/file.pdf",
  declaredMime: "application/pdf",
  sizeBytes: 128,
};

function harness(outcomes: Parameters<typeof createTestAttachmentScanProvider>[0]) {
  const audit: AttachmentScanAuditEvent[] = [];
  const manualReview: AttachmentScanAuditEvent[] = [];
  return {
    audit,
    manualReview,
    run: () => executeAttachmentScan({
      provider: createTestAttachmentScanProvider(outcomes),
      job,
      timeoutMs: 100,
      maxAttempts: 2,
      audit: async (event) => { audit.push(event); },
      enqueueManualReview: async (event) => { manualReview.push(event); },
    }),
  };
}

describe("attachment AV/CDR provider boundary", () => {
  it("releases only a clean provider verdict", async () => {
    const test = harness([{
      verdict: "clean",
      providerRequestId: "scan-1",
      completedAt: "2026-07-31T00:00:00.000Z",
    }]);
    await expect(test.run()).resolves.toEqual({
      state: "clean",
      attempts: 1,
      providerRequestId: "scan-1",
    });
    expect(test.manualReview).toHaveLength(0);
  });

  it("maps an infected verdict to quarantine", async () => {
    const test = harness([{
      verdict: "infected",
      providerRequestId: "scan-2",
      completedAt: "2026-07-31T00:00:00.000Z",
    }]);
    await expect(test.run()).resolves.toMatchObject({ state: "quarantined" });
    expect(test.audit[0].outcome).toBe("quarantined");
  });

  it("retries a bounded transient failure", async () => {
    const test = harness([
      new AttachmentScanProviderError("provider_busy", true),
      {
        verdict: "clean",
        providerRequestId: "scan-3",
        completedAt: "2026-07-31T00:00:00.000Z",
      },
    ]);
    await expect(test.run()).resolves.toMatchObject({ state: "clean", attempts: 2 });
    expect(test.audit.map((event) => event.outcome)).toEqual(["scan_failed", "clean"]);
  });

  it("sends terminal failures to manual review without releasing the file", async () => {
    const test = harness([
      new AttachmentScanProviderError("provider_unavailable", true),
      new AttachmentScanProviderError("provider_unavailable", true),
    ]);
    await expect(test.run()).resolves.toEqual({
      state: "scan_failed",
      attempts: 2,
      errorCode: "provider_unavailable",
    });
    expect(test.manualReview).toHaveLength(1);
  });
});
