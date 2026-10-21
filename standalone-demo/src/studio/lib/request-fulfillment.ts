import type { RequestStatus } from "./requests";

export type RequestFulfillmentRole =
  | "admin"
  | "it_manager"
  | "warehouse_manager"
  | "technician"
  | "employee"
  | "auditor"
  | "viewer"
  | "portal_customer"
  | null;

export type RequestActionKey =
  | "submit"
  | "approve"
  | "clarify"
  | "reject"
  | "confirm_ready"
  | "deliver"
  | "receive_return"
  | "close"
  | "change_reserved"
  | "secondary_approval"
  | "cancel";

export interface RequestActionMap {
  primary: RequestActionKey | null;
  review: RequestActionKey[];
  secondary: RequestActionKey[];
}

// The database keeps a detailed state machine; this is the sole translation
// boundary for customer-facing screens, filters, and reports.
export const DISPLAY_REQUEST_STATUSES = [
  "draft", "under_review", "needs_clarification", "preparing", "awaiting_supply",
  "ready_for_pickup", "delivered", "returned", "completed", "rejected", "cancelled",
] as const;
export type DisplayRequestStatus = (typeof DISPLAY_REQUEST_STATUSES)[number];

const OPERATIONS_ROLES = new Set<RequestFulfillmentRole>([
  "admin", "it_manager", "warehouse_manager", "technician",
]);
const REVIEW_ROLES = new Set<RequestFulfillmentRole>(["admin", "it_manager"]);
const RESERVED_DEVICE_ROLES = new Set<RequestFulfillmentRole>([
  "admin", "it_manager", "warehouse_manager",
]);
const REQUESTER_CANCELLABLE = new Set<RequestStatus>([
  "draft", "under_review", "needs_clarification",
]);

export function simplifiedRequestStatus(status: RequestStatus): DisplayRequestStatus {
  switch (status) {
    case "approved":
    case "auto_provisioning":
    case "provisioned":
    case "preparing":
      return "preparing";
    case "stock_shortage":
      return "awaiting_supply";
    case "partially_returned":
    case "overdue":
      return "delivered";
    default:
      return status;
  }
}

export function rawRequestStatusesForDisplay(status: DisplayRequestStatus): RequestStatus[] {
  const all: RequestStatus[] = [
    "draft", "under_review", "needs_clarification", "approved", "rejected",
    "auto_provisioning", "provisioned", "stock_shortage", "preparing",
    "ready_for_pickup", "delivered", "partially_returned", "returned",
    "completed", "cancelled", "overdue",
  ];
  return all.filter((value) => simplifiedRequestStatus(value) === status);
}

export function requestActionMap(input: {
  status: RequestStatus;
  role: RequestFulfillmentRole;
  hasOutstandingReturns: boolean;
  hasReservedDevices: boolean;
  secondApprovalRequired: boolean;
  secondApprovalComplete: boolean;
}): RequestActionMap {
  const { status, role } = input;
  const canOperate = OPERATIONS_ROLES.has(role);
  const canReview = REVIEW_ROLES.has(role);
  const secondary: RequestActionKey[] = [];

  // Cancellation is a requester decision, not a manager/warehouse decision.
  // The database independently enforces ownership and the pre-preparation window.
  if (role === "employee" && REQUESTER_CANCELLABLE.has(status)) secondary.push("cancel");
  if (
    input.hasReservedDevices
    && RESERVED_DEVICE_ROLES.has(role)
    && ["approved", "provisioned", "preparing"].includes(status)
  ) {
    secondary.unshift("change_reserved");
  }
  if (
    canReview
    && input.secondApprovalRequired
    && !input.secondApprovalComplete
    && ["approved", "provisioned", "preparing", "ready_for_pickup"].includes(status)
  ) {
    secondary.unshift("secondary_approval");
  }

  if (status === "under_review" && canReview) {
    return { primary: null, review: ["approve", "clarify", "reject"], secondary };
  }
  if (!canOperate) return { primary: null, review: [], secondary };

  switch (status) {
    case "draft":
      return { primary: "submit", review: [], secondary };
    case "approved":
    case "provisioned":
    case "preparing":
      return { primary: "confirm_ready", review: [], secondary };
    case "ready_for_pickup":
      // Strong-proof delivery remains fail-closed until an approved provider is
      // available. The simplified acknowledgement form is intentionally low-risk only.
      return {
        primary: input.secondApprovalRequired ? null : "deliver",
        review: [],
        secondary,
      };
    case "delivered":
    case "partially_returned":
    case "overdue":
      return {
        primary: input.hasOutstandingReturns ? "receive_return" : "close",
        review: [],
        secondary,
      };
    case "returned":
      return { primary: "close", review: [], secondary };
    default:
      return { primary: null, review: [], secondary };
  }
}
