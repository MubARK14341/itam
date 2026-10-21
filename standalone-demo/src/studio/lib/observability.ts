export type FailureMetadata = {
  kind: string;
  name?: string;
  code?: string;
  status?: number;
  digest?: string;
};

export function failureMetadata(error: unknown): FailureMetadata {
  if (error == null) return { kind: "unknown" };
  if (typeof error !== "object") return { kind: typeof error };
  const value = error as Record<string, unknown>;
  return {
    kind: "object",
    ...(typeof value.name === "string" ? { name: value.name.slice(0, 80) } : {}),
    ...(typeof value.code === "string" ? { code: value.code.slice(0, 40) } : {}),
    ...(typeof value.status === "number" ? { status: value.status } : {}),
    ...(typeof value.digest === "string" ? { digest: value.digest.slice(0, 120) } : {}),
  };
}

export function reportOperationalFailure(event: string, error: unknown): void {
  if (typeof console !== "undefined") {
    console.warn(event, failureMetadata(error));
  }
}
