export type AttachmentScanState =
  | "pending_scan"
  | "clean"
  | "infected"
  | "scan_failed"
  | "quarantined";

export interface AttachmentScanJob {
  jobId: string;
  attachmentReference: string;
  bucket: string;
  objectPath: string;
  declaredMime: string;
  sizeBytes: number;
}

export interface AttachmentScanVerdict {
  verdict: "clean" | "infected";
  providerRequestId: string;
  completedAt: string;
}

export interface AttachmentScanProvider {
  readonly name: string;
  scanAndDisarm(
    job: AttachmentScanJob,
    signal: AbortSignal,
  ): Promise<AttachmentScanVerdict>;
}

export interface AttachmentScanAuditEvent {
  jobId: string;
  attachmentReference: string;
  provider: string;
  attempt: number;
  outcome: AttachmentScanState;
  errorCode?: string;
}

export class AttachmentScanProviderError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable: boolean,
  ) {
    super(code);
    this.name = "AttachmentScanProviderError";
  }
}

export interface AttachmentScanExecution {
  state: "clean" | "quarantined" | "scan_failed";
  attempts: number;
  providerRequestId?: string;
  errorCode?: string;
}

async function withTimeout<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new AttachmentScanProviderError("provider_timeout", true));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function executeAttachmentScan(input: {
  provider: AttachmentScanProvider;
  job: AttachmentScanJob;
  timeoutMs: number;
  maxAttempts: number;
  audit: (event: AttachmentScanAuditEvent) => Promise<void>;
  enqueueManualReview: (event: AttachmentScanAuditEvent) => Promise<void>;
}): Promise<AttachmentScanExecution> {
  if (input.timeoutMs < 1 || input.maxAttempts < 1 || input.maxAttempts > 5) {
    throw new Error("invalid_attachment_scan_execution_policy");
  }

  for (let attempt = 1; attempt <= input.maxAttempts; attempt += 1) {
    try {
      const verdict = await withTimeout(input.timeoutMs, (signal) =>
        input.provider.scanAndDisarm(input.job, signal));
      const state = verdict.verdict === "clean" ? "clean" : "quarantined";
      await input.audit({
        jobId: input.job.jobId,
        attachmentReference: input.job.attachmentReference,
        provider: input.provider.name,
        attempt,
        outcome: state,
      });
      return {
        state,
        attempts: attempt,
        providerRequestId: verdict.providerRequestId,
      };
    } catch (error) {
      const providerError = error instanceof AttachmentScanProviderError
        ? error
        : new AttachmentScanProviderError("provider_unclassified_failure", false);
      const terminal = !providerError.retryable || attempt === input.maxAttempts;
      const event: AttachmentScanAuditEvent = {
        jobId: input.job.jobId,
        attachmentReference: input.job.attachmentReference,
        provider: input.provider.name,
        attempt,
        outcome: "scan_failed",
        errorCode: providerError.code,
      };
      await input.audit(event);
      if (terminal) {
        await input.enqueueManualReview(event);
        return {
          state: "scan_failed",
          attempts: attempt,
          errorCode: providerError.code,
        };
      }
    }
  }

  throw new Error("unreachable_attachment_scan_state");
}

export function createTestAttachmentScanProvider(
  outcomes: Array<AttachmentScanVerdict | AttachmentScanProviderError>,
): AttachmentScanProvider {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("test_attachment_scan_provider_forbidden_outside_tests");
  }
  let index = 0;
  return {
    name: "deterministic_test_only",
    async scanAndDisarm() {
      const outcome = outcomes[Math.min(index, outcomes.length - 1)];
      index += 1;
      if (!outcome) {
        throw new AttachmentScanProviderError("test_outcome_missing", false);
      }
      if (outcome instanceof AttachmentScanProviderError) throw outcome;
      return outcome;
    },
  };
}
