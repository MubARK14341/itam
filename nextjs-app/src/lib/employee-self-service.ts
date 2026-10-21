import { createClient } from "@/lib/supabase/client";

export type EmployeeRequestSummary = {
  id: string;
  request_number: string;
  status: string;
  project_name: string | null;
  pickup_date: string | null;
  return_date: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  item_count: number;
};

export type EmployeeRequestDetail = {
  ok: boolean;
  error?: string;
  request?: EmployeeRequestSummary;
  items?: Array<{
    id: string;
    quantity: number;
    requested_description: string;
    requested_category: string | null;
    notes: string | null;
  }>;
  events?: Array<{
    id: string;
    event_type: string;
    message: string | null;
    created_at: string;
  }>;
};

export type EmployeeAsset = {
  asset_id: string;
  asset_tag: string | null;
  name: string | null;
  status: string;
  condition_grade: string | null;
  assigned_at: string;
  due_return_date: string | null;
  assignment_status: string;
  return_requested: boolean;
  open_issue_count: number;
};

export type EmployeeReturnRequest = {
  id: string;
  asset_id: string;
  asset_tag: string | null;
  asset_name: string | null;
  reason: string;
  status: string;
  requested_at: string;
  resolution_note: string | null;
  resolved_at: string | null;
};

export type WarehouseReturnIntake = {
  id: string;
  asset_id: string;
  asset_tag: string | null;
  asset_name: string | null;
  employee_name: string | null;
  reason: string;
  status: string;
  requested_at: string;
};

type RpcResponse = { ok: boolean; id?: string; error?: string };

export function employeeOperationId() {
  return crypto.randomUUID();
}

export async function listMyEmployeeRequests() {
  const { data, error } = await createClient().rpc("employee_my_requests");
  return {
    rows: (Array.isArray(data) ? data : []) as unknown as EmployeeRequestSummary[],
    error,
  };
}

export async function getMyEmployeeRequest(id: string) {
  const { data, error } = await createClient().rpc("employee_my_request", {
    p_request_id: id,
  });
  return { detail: data as unknown as EmployeeRequestDetail | null, error };
}

export async function createMyEmployeeRequest(input: {
  projectName: string;
  pickupDate: string;
  returnDate: string;
  notes: string;
  description: string;
  category: string;
  quantity: number;
}) {
  const { data, error } = await createClient().rpc("request_create_employee_self", {
    p_status: "under_review",
    p_project_name: input.projectName.trim() || null,
    p_pickup_date: input.pickupDate || null,
    p_return_date: input.returnDate || null,
    p_notes: input.notes.trim() || null,
    p_items: [{
      item_kind: "custom",
      quantity: input.quantity,
      requested_description: input.description.trim(),
      requested_category: input.category.trim() || null,
      accept_alternative: true,
      notes: null,
    }],
  });
  return { data: data as unknown as RpcResponse | null, error };
}

export async function replyToMyRequest(id: string, message: string) {
  const { data, error } = await createClient().rpc(
    "employee_reply_request_clarification",
    {
      p_request_id: id,
      p_message: message.trim(),
      p_operation_id: employeeOperationId(),
    },
  );
  return { data: data as unknown as RpcResponse | null, error };
}

export async function listMyEmployeeAssets() {
  const { data, error } = await createClient().rpc("employee_my_assets");
  return {
    rows: (Array.isArray(data) ? data : []) as unknown as EmployeeAsset[],
    error,
  };
}

export async function reportMyAssetIssue(assetId: string, description: string) {
  const { data, error } = await createClient().rpc("employee_report_asset_issue", {
    p_asset_id: assetId,
    p_description: description.trim(),
    p_operation_id: employeeOperationId(),
  });
  return { data: data as unknown as RpcResponse | null, error };
}

export async function requestMyAssetReturn(assetId: string, reason: string) {
  const { data, error } = await createClient().rpc("employee_request_asset_return", {
    p_asset_id: assetId,
    p_reason: reason.trim(),
    p_operation_id: employeeOperationId(),
  });
  return { data: data as unknown as RpcResponse | null, error };
}

export async function listMyEmployeeReturnRequests() {
  const { data, error } = await createClient().rpc("employee_my_return_requests");
  return {
    rows: (Array.isArray(data) ? data : []) as unknown as EmployeeReturnRequest[],
    error,
  };
}

export async function listWarehouseEmployeeReturnQueue() {
  const { data, error } = await (createClient() as any).rpc("warehouse_employee_return_queue");
  return { rows: (Array.isArray(data) ? data : []) as WarehouseReturnIntake[], error };
}

export async function receiveWarehouseEmployeeReturn(id: string, condition: "sound" | "needs_inspection", note: string) {
  const { data, error } = await (createClient() as any).rpc("warehouse_receive_employee_return", {
    p_return_request_id: id,
    p_condition: condition,
    p_note: note.trim() || null,
    p_operation_id: employeeOperationId(),
  });
  return { data: data as RpcResponse | null, error };
}
