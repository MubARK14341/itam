import { executeIdempotentMutation } from "@/lib/idempotent-operation";

function stockMoveError(message: string): string {
  if (message.includes("insufficient_stock")) return "الكمية غير كافية — لا يُسمح برصيد سالب.";
  if (message.includes("not_authorized")) return "غير مخوّل لهذه العملية.";
  if (message.includes("invalid_quantity")) return "أدخل كمية صحيحة.";
  if (message.includes("invalid_type")) return "نوع الحركة غير صالح.";
  if (message.includes("consumable_not_found")) return "العنصر غير موجود.";
  return message;
}

export async function consumableStockMove(args: {
  consumableId: string; type: "in" | "out"; quantity: number; reason: string | null;
  unitCost?: number | null; supplierId?: string | null; invoiceNumber?: string | null;
  invoiceDate?: string | null; employeeId?: string | null; departmentId?: string | null;
  operationId?: string;
}): Promise<string | null> {
  const error = await executeIdempotentMutation({
    type: "consumable_stock_move", targetId: args.consumableId,
    rpcName: "consumable_stock_move_idempotent", operationId: args.operationId,
    params: {
      p_consumable_id: args.consumableId, p_type: args.type, p_quantity: args.quantity,
      p_reason: args.reason, p_unit_cost: args.unitCost ?? null,
      p_supplier_id: args.supplierId ?? null, p_invoice_number: args.invoiceNumber ?? null,
      p_invoice_date: args.invoiceDate ?? null, p_employee_id: args.employeeId ?? null,
      p_department_id: args.departmentId ?? null,
    },
  });
  return error ? stockMoveError(error) : null;
}
