import type { Dict } from "@/lib/i18n";

export function idempotentOperationError(code: string, common: Dict["common"]): string | null {
  switch (code) {
    case "operation_result_unknown": return common.operationPending;
    case "operation_pending": return common.operationPendingHint;
    case "operation_id_conflict": return common.operationConflict;
    case "operation_storage_unavailable": return common.operationStorageUnavailable;
    case "operation_previous_completed": return common.operationPreviousCompleted;
    case "not_authorized": return common.notAuthorized;
    default: return null;
  }
}
