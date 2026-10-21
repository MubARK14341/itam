// أنواع مبسّطة للصفوف التي نستعلم عنها (كافية للـMVP)
export type AssetStatus =
  | "available" | "reserved" | "in_maintenance";

export interface Category { id: string; name: string; name_ar: string | null; prefix: string; kind: string; management_type: string; }
export interface LocationRow { id: string; name: string; name_ar: string | null; code: string | null; }
export interface Supplier { id: string; name: string; name_ar: string | null; }
export interface Company { id: string; name: string; notes: string | null; is_active: boolean; }
export interface Department { id: string; name: string; name_ar: string | null; code: string | null; }
export interface AssetPool { id: string; name: string; name_ar: string | null; category_id: string | null; company_id: string | null; }
export interface Employee { id: string; full_name: string; full_name_ar: string | null; employee_no: string | null; }
export interface ModelRow { id: string; brand: string; model_name: string; category_id: string; }

export interface AssetRow {
  id: string;
  asset_tag: string | null;
  qr_token: string;
  name: string | null;
  serial_number: string | null;
  status: AssetStatus;
  category_id: string;
  location_id: string | null;
  condition_grade: string | null;
  purchase_date: string | null;
  purchase_cost: number | null;
  warranty_end: string | null;
  currency: string | null;
  special_attributes: Record<string, unknown> | null;
  company_id: string | null;
  rfid_tag?: string | null;
  pool_id?: string | null;
  // إعفاء موثق من الرقم التسلسلي (قوائم العمل) — اختياري: ليس كل استعلام يجلبه.
  serial_exempt?: boolean | null;
  serial_exempt_reason?: string | null;
  category: { name_ar: string | null; name: string } | null;
  model: { brand: string; model_name: string } | null;
  location: { name_ar: string | null; name: string } | null;
  holder: { full_name_ar: string | null; full_name: string } | null;
  company: { name: string } | null;
  pool?: { name: string; name_ar: string | null } | null;
}

/** Operational inventory only; full AssetRow/detail consumers retain their contract. */
export type AssetInventoryRow = Pick<AssetRow,
  | "id" | "asset_tag" | "qr_token" | "name" | "serial_number" | "status"
  | "category_id" | "location_id" | "company_id"
  | "category" | "location" | "holder" | "company" | "pool_id" | "pool"
> & {
  model: { brand: string | null; model_name: string } | null;
  /** Raw JSON is preserved; only guarded readers interpret named attributes. */
  special_attributes: unknown;
  last_return_condition?: string | null;
};

export interface ConsumableRow {
  id: string; name: string; brand: string | null; sku: string | null;
  unit: string; quantity_on_hand: number; reorder_level: number;
  category_id: string | null;
  company_id: string | null; supplier_id?: string | null; location_id?: string | null;
  rfid_tag?: string | null; unit_cost?: number | null;
  category: { name_ar: string | null; name: string } | null;
  company: { name: string } | null;
  /** Optional for legacy projections; operational list rows include this RLS-bound mini. */
  location?: { name: string; name_ar: string | null; code: string | null } | null;
}
