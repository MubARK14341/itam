// ============================================================================
//  القيم الافتراضية للمخزون (Inventory defaults) — تُخزَّن في جدول inventory_settings
//  (صف واحد id='main'). إضافي وآمن: القراءة لكل معتمد، التعديل admin/it_manager (RLS).
//  تُستخدم كقيم أولية عند إنشاء عناصر جديدة (أصل/مستهلك) — لا تفرض شيئًا على البيانات الحالية.
// ============================================================================
import { createClient } from "@/lib/supabase/client";

const supabase = () => createClient();

export interface InventorySettings {
  default_location_id: string | null;
  default_reorder_level: number;
}

export const DEFAULT_INVENTORY_SETTINGS: InventorySettings = {
  default_location_id: null,
  default_reorder_level: 0,
};

const SETTINGS_ID = "main";
const SETTINGS_COLS = "default_location_id,default_reorder_level";

// يقرأ القيم الافتراضية؛ يتدرّج بأمان إلى الافتراضي إن غاب الجدول/الصف أو مُنعت القراءة.
export async function getInventorySettings(): Promise<InventorySettings> {
  try {
    const { data, error } = await supabase()
      .from("inventory_settings").select(SETTINGS_COLS).eq("id", SETTINGS_ID).maybeSingle();
    if (error || !data) return { ...DEFAULT_INVENTORY_SETTINGS };
    return { ...DEFAULT_INVENTORY_SETTINGS, ...(data as Partial<InventorySettings>) };
  } catch {
    return { ...DEFAULT_INVENTORY_SETTINGS };
  }
}

// تحديث القيم الافتراضية (admin/it_manager فقط عبر RLS). updated_by/updated_at يُختمان بالخادم.
export async function updateInventorySettings(p: InventorySettings): Promise<string | null> {
  const { error } = await supabase().from("inventory_settings").upsert({
    id: SETTINGS_ID,
    default_location_id: p.default_location_id || null,
    default_reorder_level: Math.max(0, Math.trunc(Number(p.default_reorder_level) || 0)),
  });
  return error?.message ?? null;
}
