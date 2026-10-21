import { getDemoStore, assertDemoAuthorizationContext, type DemoStore } from "./store";
import { type DemoState, type OperationContext, type Row, DemoError, str, rows, find, uid, now, requireActor, financial } from "./types";
import { resolveDemoPortalSettings } from "./portal-settings";

const MAX_ATTACHMENT_BYTES = 10485760;
const allowedMimeTypes = new Set([
  "application/pdf", "image/png", "image/jpeg", "image/webp", "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
const uuidPattern = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const portalPathPattern = new RegExp(`^requests/(${uuidPattern})/portal/(?:customer_visible/)?[A-Za-z0-9._-]{1,150}$`);
const urls = new Set<string>();
let attachedStore: DemoStore | null = null;

function ownUrls(store: DemoStore): void {
  if (attachedStore === store) return;
  attachedStore = store;
  let generation = store.getGeneration();
  store.subscribe(() => {
    if (generation !== store.getGeneration()) {
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
      generation = store.getGeneration();
    }
  });
}

export function validateDemoAttachmentBlob(blob: Blob): void {
  if (!allowedMimeTypes.has(blob.type)) throw new DemoError("22023", "bad_type");
  if (blob.size <= 0 || blob.size > MAX_ATTACHMENT_BYTES) throw new DemoError("413", "too_large", 413);
}

export function validateDemoAttachmentMetadata(s: DemoState, c: OperationContext, input: Row): Row {
  if (["scan_status", "scan_provider", "scan_reason", "content_sha256", "scanned_at"].some(k => Object.hasOwn(input, k))) throw new DemoError("42501", "scanner_evidence_forbidden", 403);
  const path = str(input.storage_path), key = `attachments/${path}`;
  canAccessBlob(s, c, key, true);
  const roots: Record<string,string> = { asset: "assets", consumable: "consumables", maintenance: "maintenance" };
  const root = roots[str(input.entity_type)], kind = str(input.kind), parts = path.split("/");
  const invoices = ["warranty_invoice", "purchase_invoice", "consumable_invoice", "replenishment_invoice", "maintenance_invoice"];
  if (![...invoices, "asset_photo", "consumable_photo", "device_photo", "other"].includes(kind)) throw new DemoError("22023", "invalid_attachment_kind");
  if (!root || parts.length !== 4 || parts[0] !== root || parts[1] !== input.entity_id || parts[2] !== kind || !/^[A-Za-z0-9._-]{1,150}$/.test(parts[3])) throw new DemoError("22023", "invalid_attachment_path");
  find(s, root === "maintenance" ? "maintenance_records" : root, input.entity_id);
  if (!str(input.file_name).trim() || str(input.file_name).length > 200) throw new DemoError("22023", "invalid_attachment_name");
  const actor = requireActor(c), blob = s.blobs[key], owner = rows(s, "demo_blob_owners").find(r => r.key === key);
  if (!blob || owner?.actor_id !== actor.userId) throw new DemoError("42501", "attachment_object_not_owned", 403);
  validateDemoAttachmentBlob(blob);
  if (rows(s,"attachments").some(r=>r.storage_path===path)) throw new DemoError("23505", "already_registered", 409);
  return {entity_type:input.entity_type,entity_id:input.entity_id,kind,file_name:input.file_name,storage_path:path,mime_type:blob.type,size_bytes:blob.size,uploaded_by:actor.userId,classification:invoices.includes(kind)?"financial":"internal",scan_status:"pending"};
}

export function portalAttachmentWriteRequest(s: DemoState, c: OperationContext, path: string): Row {
  const actor = requireActor(c);
  if (!actor.portalRole || !["authorized_requester", "project_manager"].includes(actor.portalRole)) {
    throw new DemoError("42501", "not_authorized", 403);
  }
  if (resolveDemoPortalSettings(s, actor.customerId).allow_attachments !== true) {
    throw new DemoError("42501", "attachments_disabled", 403);
  }
  const match = path.match(portalPathPattern);
  if (!match) throw new DemoError("22023", "invalid_path");
  const request = find(s, "requests", match[1]);
  if (request.customer_id !== actor.customerId || (actor.portalRole === "authorized_requester" && request.submitted_by !== actor.userId)) {
    throw new DemoError("42501", "not_authorized", 403);
  }
  if (!["draft", "under_review", "needs_clarification"].includes(str(request.status))) {
    throw new DemoError("22023", "invalid_state");
  }
  return request;
}

export function canAccessBlob(s: DemoState, c: OperationContext, key: string, write = false): void {
  const actor = requireActor(c);
  if (actor.portalRole) {
    const user = rows(s, "customer_portal_users").find(u => u.id === actor.userId);
    const customer = rows(s, "customers").find(u => u.id === actor.customerId);
    const config = resolveDemoPortalSettings(s, actor.customerId);
    if (user?.is_active !== true || customer?.is_active !== true || customer.approval_status !== "approved" || config?.portal_enabled !== true) {
      throw new DemoError("42501", "portal_disabled", 403);
    }
  } else {
    const profile = rows(s, "app_users").find(u => u.id === actor.userId);
    const scenario = s.authScenario?.actorId === actor.id ? s.authScenario.status : null;
    if (profile?.is_active !== true || profile.approval_status !== "approved" || (scenario !== null && scenario !== "approved")) {
      throw new DemoError("42501", "account_not_approved", 403);
    }
  }
  const slash = key.indexOf("/");
  const bucket = key.slice(0, slash), path = key.slice(slash + 1);
  if (!["attachments", "request-attachments"].includes(bucket)) {
    throw new DemoError("DEMO_UNSUPPORTED_OPERATION", "Unsupported local attachment bucket", 404);
  }
  const metadata = rows(s, "demo_blob_owners").find(x => x.key === key);
  if (actor.portalRole) {
    if (bucket !== "request-attachments") throw new DemoError("42501", "not_authorized", 403);
    if (write) {
      portalAttachmentWriteRequest(s, c, path);
      if (metadata && metadata.actor_id !== actor.userId) throw new DemoError("42501", "not_attachment_owner", 403);
    } else {
      const attachment = rows(s, "request_attachments").find(x => x.storage_path === path);
      if (!attachment || attachment.classification !== "customer_visible" || !(attachment.uploaded_by_kind === "portal" || attachment.visible_to_customer)) {
        throw new DemoError("42501", "not_authorized", 403);
      }
      if (attachment.scan_status !== "clean") throw new DemoError("42501", "attachment_quarantined", 403);
      const request = find(s, "requests", attachment.request_id);
      if (request.customer_id !== actor.customerId || (actor.portalRole === "authorized_requester" && request.submitted_by !== actor.userId)) {
        throw new DemoError("42501", "not_authorized", 403);
      }
    }
    return;
  }
  if (!actor.role || actor.role === "employee") throw new DemoError("42501", "not_authorized", 403);
  if (write) {
    if (!["admin", "it_manager", "technician"].includes(actor.role)) throw new DemoError("42501", "not_authorized", 403);
    const validPath = bucket === "request-attachments"
      ? new RegExp(`^requests/${uuidPattern}/staff/(?:(?:internal|customer_visible|financial)/)?[A-Za-z0-9._-]{1,150}$`).test(path)
      : new RegExp(`^(?:assets|consumables|maintenance)/${uuidPattern}/(?:warranty_invoice|purchase_invoice|consumable_invoice|replenishment_invoice|maintenance_invoice|asset_photo|consumable_photo|device_photo|other)/[A-Za-z0-9._-]{1,150}$`).test(path);
    if (!validPath) throw new DemoError("22023", "invalid_path");
    if (metadata && metadata.actor_id !== actor.userId) throw new DemoError("42501", "not_attachment_owner", 403);
    if (/\/(?:financial|\w+_invoice)\//.test(path) && !financial(c)) throw new DemoError("42501", "financial_access_denied", 403);
  }
  const attachment = rows(s, bucket === "attachments" ? "attachments" : "request_attachments").find(x => x.storage_path === path);
  if (!write && (!attachment || attachment.scan_status !== "clean")) throw new DemoError("42501", "attachment_quarantined", 403);
  if ((attachment?.classification === "financial" || metadata?.classification === "financial") && !financial(c)) {
    throw new DemoError("42501", "financial_access_denied", 403);
  }
}

export async function createDemoAttachmentUrl(bucket: string, path: string, _download?: string | boolean): Promise<string | null> {
  const store = getDemoStore();
  await store.ready;
  const ctx = store.capture(), s = await store.read(), key = `${bucket}/${path}`;
  assertDemoAuthorizationContext(s, ctx);
  canAccessBlob(s, ctx, key);
  const blob = s.blobs[key];
  if (!blob) return null;
  ownUrls(store);
  const url = URL.createObjectURL(blob);
  urls.add(url);
  return url;
}
export function revokeDemoAttachmentUrl(url: string): void {
  if (urls.delete(url)) URL.revokeObjectURL(url);
}
export async function uploadDemoAttachment(store: DemoStore, ctx: OperationContext, key: string, blob: Blob, upsert = false): Promise<unknown> {
  validateDemoAttachmentBlob(blob);
  return store.transact(ctx, s => {
    canAccessBlob(s, ctx, key, true);
    if (s.blobs[key]) {
      if (!upsert) throw new DemoError("23505", "The resource already exists", 409);
      // The source's storage policies do not grant object updates.
      throw new DemoError("42501", "attachment_update_forbidden", 403);
    }
    s.blobs[key] = blob;
    rows(s, "demo_blob_owners").push({ id: uid(), key, actor_id: ctx.actor?.userId, created_at: now(), classification: /\/(?:financial|\w+_invoice)\//.test(key) ? "financial" : "internal" });
    return { Id: uid(), Key: key, path: key.split("/").slice(1).join("/") };
  });
}
export async function removeDemoAttachments(store: DemoStore, ctx: OperationContext, bucket: string, paths: unknown): Promise<unknown> {
  if (!Array.isArray(paths)) throw new DemoError("22023", "invalid_paths");
  return store.transact(ctx, s => paths.map(path => {
    const key = `${bucket}/${str(path)}`;
    canAccessBlob(s, ctx, key, true);
    const registered = rows(s, bucket === "attachments" ? "attachments" : "request_attachments").some(a => a.storage_path === path);
    if (registered) throw new DemoError("42501", "attachment_object_registered", 403);
    delete s.blobs[key];
    s.tables.demo_blob_owners = rows(s, "demo_blob_owners").filter(x => x.key !== key);
    return { name: path };
  }));
}
