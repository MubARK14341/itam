import type { JsonObject, OutboxRow } from "./types.ts";

export class AutomationDb {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(supabaseUrl: string, serviceRoleKey: string) {
    this.baseUrl = `${supabaseUrl.replace(/\/$/, "")}/rest/v1`;
    this.headers = {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      "content-type": "application/json",
    };
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}/${path}`, {
      ...init,
      headers: { ...this.headers, ...(init.headers ?? {}) },
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`database_${response.status}:${body.slice(0, 300)}`);
    return (body ? JSON.parse(body) : null) as T;
  }

  select<T>(table: string, query: string): Promise<T[]> {
    return this.request<T[]>(`${table}?${query}`);
  }

  async selectAll<T>(table: string, query: string, pageSize = 1000): Promise<T[]> {
    const rows: T[] = [];
    for (let offset = 0; ; offset += pageSize) {
      const page = await this.request<T[]>(`${table}?${query}`, {
        headers: { "range-unit": "items", range: `${offset}-${offset + pageSize - 1}` },
      });
      rows.push(...page);
      if (page.length < pageSize) return rows;
    }
  }

  rpc<T>(name: string, args: JsonObject): Promise<T> {
    return this.request<T>(`rpc/${name}`, { method: "POST", body: JSON.stringify(args) });
  }

  startRun(runKey: string, job: string, mode: string, version: string): Promise<string | null> {
    return this.rpc("automation_start_run", { p_run_key: runKey, p_job: job, p_mode: mode, p_worker_version: version });
  }

  finishRun(runId: string, status: "succeeded" | "failed" | "skipped", metrics: Record<string, number>, error?: string): Promise<null> {
    return this.rpc("automation_finish_run", {
      p_run_id: runId, p_status: status,
      p_scanned: metrics.scanned ?? 0, p_enqueued: metrics.enqueued ?? 0,
      p_claimed: metrics.claimed ?? 0, p_sent: metrics.sent ?? 0,
      p_failed: metrics.failed ?? 0, p_duplicates: metrics.duplicates ?? 0,
      p_delivery_unknown: metrics.deliveryUnknown ?? 0, p_error: error ?? null,
    });
  }

  claim(limit: number, lockToken: string): Promise<OutboxRow[]> {
    return this.rpc("automation_claim_outbox", { p_limit: limit, p_lock_token: lockToken });
  }

  enqueue(args: JsonObject): Promise<string | null> {
    return this.rpc("automation_enqueue", args);
  }

  recordHealth(key: string, eventType: string, severity: string, payload: JsonObject): Promise<string> {
    return this.rpc("automation_record_health", { p_health_key: key, p_event_type: eventType, p_severity: severity, p_payload: payload });
  }
}
