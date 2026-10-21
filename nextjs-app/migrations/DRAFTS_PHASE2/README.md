# Phase 2 — Migration Package (DRAFTS ONLY / مسودّات فقط)

> ⛔ **لا شيء هنا مُطبَّق.** هذه مسودّات SQL/Storage للمراجعة والموافقة قبل التنفيذ.
> لا تُشغَّل أي منها على القاعدة الحيّة إلا بعد موافقة صريحة + مطابقة أسماء الأعمدة عبر `list_tables`.

هذه الحزمة تُكمل خطة **PHASE_2_PRODUCTION_READINESS_PLAN.md**. الملفات:

| الملف | يعالج | الطبقة | Destructive؟ | الحالة |
|---|---|---|---|---|
| `DRAFT_medium2_storage_write_policies.sql` | MEDIUM-2 — تقييد الكتابة على Storage حسب الدور/نوع الملف | Storage policy | ❌ لا | ✅ **طُبِّق** (`20260701141909`) |
| `DRAFT_medium1_consumable_stock_atomic.sql` | MEDIUM-1 — RPC ذرّي لتحريك المخزون (القيد كان موجودًا) | DB (RPC) | ❌ لا | ✅ **طُبِّق** (`20260701142912`) |
| `DRAFT_high1_financial_column_protection.sql` + `DRAFT_high1b_column_grants_correction.sql` | HIGH-1 — دالة + RPCs مالية + trigger، ثم حجب على مستوى العمود (revoke table + grant columns) | DB (privileges + RPCs + trigger) | ❌ لا | ✅ **طُبِّق** (`20260701145434` + `20260701150032`) |

**ترتيب التطبيق:** ~~MEDIUM-2~~ ✅ → ~~MEDIUM-1~~ ✅ → ~~HIGH-1~~ ✅. كل الدفعات طُبِّقت.

**قبل أي تطبيق (خطوة قراءة فقط، تحتاج موافقة لتشغيل SQL للقراءة):**
1. `list_tables` لتأكيد أسماء الأعمدة المالية الفعلية (خصوصًا وجود `salvage_rate`).
2. سرد سياسات `storage.objects` الحالية لالتقاط أسماء سياسات الكتابة العامة (لأجل الحذف والـ rollback).
3. `select count(*) from public.consumables where quantity_on_hand < 0;` — يجب أن يكون `0` قبل قيد CHECK.

**كل ملف يحوي في ترويسته:** الهدف · ماذا يغيّر · destructive؟ · rollback · test plan · مخاطر التطبيق.

> تعديلات الكود المقترنة بـ HIGH-1 و MEDIUM-1 **لم تُطبَّق** لأنها ستكسر التطبيق إن سبقت الـ Migration.
> تُطبَّق مع الـ Migration في نفس النافذة. قائمتها في ترويسة كل draft وفي خطة Phase 2.
