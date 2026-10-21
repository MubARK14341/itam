import { DemoError, find, num, object, portal, quantity, rows, str, type DemoState, type OperationContext, type Row } from "./types";

const requestFields = new Set(["project_name", "project_city", "contact_phone", "contact_email", "request_type", "pickup_date", "return_date", "notes", "items"]);
const itemFields = new Set(["requested_kind", "requested_description", "requested_category", "quantity", "preferred_model", "accept_alternative", "needs_purchase", "category_key", "preferred_company_id", "model_id", "consumable_id", "additional_quantity_requested"]);
export const definitivePortalErrors = new Set(["invalid_input", "invalid_item", "server_fields_forbidden", "invalid_quantity", "project_name_required", "city_required", "delivery_date_required", "delivery_date_in_past", "phone_required", "catalog_item_not_allowed", "additional_quantity_acknowledgement_required", "description_required", "invalid_kind", "items_required", "too_many_items"]);
function invalid(message: string): never { throw new DemoError("22023", message); }
function permitted(input: Row, fields: ReadonlySet<string>): void { if (Object.keys(input).some(k => !fields.has(k))) invalid("server_fields_forbidden"); }
export function riyadhToday(): string { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Riyadh", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }
function date(value: unknown, required: boolean): string | null {
  if (value == null || value === "") { if (required) invalid("delivery_date_required"); return null; }
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0,10) !== value) invalid("invalid_input");
  return value;
}
export function portalCategoryKey(category: Row): string | null {
  if (category.kind === "consumable") return "consumable";
  const key = str(category.name).trim().toLowerCase();
  return ({ camera: "camera", printer: "printer", laptop: "laptop", "pos device": "pos", "barcode scanner": "scanner" } as Record<string,string>)[key] ?? null;
}
function allowedCategory(s: DemoState, customerId: unknown, category: Row): boolean {
  const allowed = rows(s, "customer_allowed_categories").filter(r => r.customer_id === customerId);
  return category.is_active === true && (allowed.length === 0 || allowed.some(r => r.category_key === portalCategoryKey(category)));
}
export function portalCatalog(s: DemoState, c: OperationContext): Row[] {
  const actor = portal(c), companies = rows(s, "customer_allowed_companies").filter(r => r.customer_id === actor.customerId);
  return rows(s, "models").flatMap(model => {
    const category = rows(s,"categories").find(r=>r.id===model.category_id), company = rows(s,"companies").find(r=>r.id===model.company_id);
    if (!category || !company || !allowedCategory(s,actor.customerId,category) || company.is_active !== true || model.is_active === false || companies.length > 0 && !companies.some(r=>r.company_id===company.id)) return [];
    return [{category_id:category.id,category_name:category.name,category_name_ar:category.name_ar,company_id:company.id,company_name:company.name,model_id:model.id,model_name:model.model_name}];
  }).sort((a,b)=>`${a.category_name}:${a.company_name}:${a.model_name}`.localeCompare(`${b.category_name}:${b.company_name}:${b.model_name}`));
}
export function portalConsumables(s: DemoState, c: OperationContext): Row[] {
  const actor = portal(c);
  return rows(s,"consumables").flatMap(item=>{const category=rows(s,"categories").find(r=>r.id===item.category_id);return item.is_active===true&&category&&allowedCategory(s,actor.customerId,category)?[{consumable_id:item.id,consumable_name:item.name,category_id:category.id,category_name:category.name,category_name_ar:category.name_ar}]:[];});
}
export function portalAvailability(s: DemoState, c: OperationContext, p: Row): Row {
  portal(c);
  if(p.p_item_type === "durable") {
    if(!p.p_category_id || !p.p_model_id || !portalCatalog(s,c).some(r=>r.category_id===p.p_category_id&&r.model_id===p.p_model_id)) invalid("catalog_item_not_allowed");
    return {ok:true,item_type:"durable",available_quantity:rows(s,"assets").filter(a=>a.category_id===p.p_category_id&&a.model_id===p.p_model_id&&a.is_active===true&&a.archived_at==null&&a.status==="available"&&a.assigned_to_employee_id==null&&!rows(s,"asset_assignments").some(x=>x.asset_id===a.id&&x.status==="active")&&!rows(s,"request_items").some(x=>x.asset_id===a.id&&["provisioned","preparing","ready_for_pickup","delivered","partially_returned","overdue"].includes(str(rows(s,"requests").find(r=>r.id===x.request_id)?.status)))).length};
  }
  if(p.p_item_type === "consumable") {
    if(!portalConsumables(s,c).some(r=>r.consumable_id===p.p_consumable_id)) invalid("catalog_item_not_allowed");
    const item=find(s,"consumables",p.p_consumable_id);
    const reserved=rows(s,"request_items").filter(it=>it.consumable_id===item.id&&rows(s,"requests").some(r=>r.id===it.request_id&&["under_review","approved","auto_provisioning","provisioned","stock_shortage","preparing","ready_for_pickup"].includes(str(r.status))&&r.portal_approval_status!=="rejected_by_project_manager")).reduce((n,it)=>n+Math.max(num(it.quantity)-num(it.delivered_quantity),0),0);
    return {ok:true,item_type:"consumable",available_quantity:Math.max(num(item.quantity_on_hand)-reserved,0)};
  }
  invalid("invalid_item_type");
}
export function validatePortalRequestInput(s: DemoState, c: OperationContext, input: Row, atomic: boolean): Row {
  const actor=portal(c,true);permitted(input,requestFields);
  const name=str(input.project_name).trim(),city=str(input.project_city).trim();
  if(!name||name.length>160)invalid("project_name_required");if(!city||city.length>120)invalid("city_required");
  const pickup=date(input.pickup_date,true)!;if(pickup<riyadhToday())invalid("delivery_date_in_past");const returned=date(input.return_date,false);
  const profile=find(s,"customer_portal_users",actor.userId);if(!str(profile.phone).trim())invalid("phone_required");
  if(atomic){if(!Array.isArray(input.items)||input.items.length===0)invalid("items_required");if(input.items.length>500)invalid("too_many_items");}
  return {...input,project_name:name,project_city:city,request_type:"rental",pickup_date:pickup,return_date:returned,contact_phone:str(profile.phone).trim(),contact_email:actor.email};
}
export function validatePortalItem(s: DemoState, c: OperationContext, input: Row): Row {
  permitted(input,itemFields);const qty=quantity(input.quantity),kind=str(input.requested_kind),description=str(input.requested_description).trim()||null;
  const base:Row={quantity:qty,requested_kind:kind,requested_description:description,requested_category:str(input.requested_category).trim()||null,preferred_model:null,preferred_company_id:null,model_id:null,portal_model_id:null,consumable_id:null,asset_id:null,additional_quantity_requested:false};
  if(kind==="custom") {if(!description)invalid("description_required");return{...base,item_kind:"custom",accept_alternative:input.accept_alternative===true,needs_purchase:input.needs_purchase===true};}
  if(kind!=="existing_asset"&&kind!=="consumable")invalid("invalid_kind");
  let availability:Row;
  if(kind==="consumable") {availability=portalAvailability(s,c,{p_item_type:"consumable",p_consumable_id:input.consumable_id});const item=find(s,"consumables",input.consumable_id);base.consumable_id=item.id;base.item_kind="consumable";base.requested_category=find(s,"categories",item.category_id).name_ar??base.requested_category;base.accept_alternative=false;}
  else {const model=rows(s,"models").find(m=>m.id===input.model_id);if(!model)invalid("catalog_item_not_allowed");availability=portalAvailability(s,c,{p_item_type:"durable",p_category_id:model.category_id,p_model_id:model.id});Object.assign(base,{item_kind:"custom",model_id:model.id,portal_model_id:model.id,category_id:model.category_id,preferred_model:str(input.preferred_model).trim()||null,accept_alternative:input.accept_alternative!==false});}
  if(qty>num(availability.available_quantity)&&input.additional_quantity_requested!==true)invalid("additional_quantity_acknowledgement_required");
  return{...base,needs_purchase:false,additional_quantity_requested:input.additional_quantity_requested===true};
}
export function validatePortalSubmission(s: DemoState, c: OperationContext, request: Row): void {
  if(request.status!=="draft"||request.portal_approval_status!=="not_required")invalid("invalid_state");
  if(!str(request.project_name).trim())invalid("project_name_required");if(!str(request.project_city).trim())invalid("city_required");
  const pickup=date(request.pickup_date,true)!;if(pickup<riyadhToday())invalid("delivery_date_in_past");
  const list=rows(s,"request_items").filter(it=>it.request_id===request.id);if(list.length===0)invalid("no_items");
  const requiresReturn=list.some(it=>it.portal_model_id!=null);if(requiresReturn){if(!request.return_date)invalid("return_date_required");if(str(request.return_date)<=pickup)invalid("return_date_invalid");}
  for(const item of list){let availability:Row;if(item.portal_model_id){const model=find(s,"models",item.portal_model_id);availability=portalAvailability(s,c,{p_item_type:"durable",p_category_id:model.category_id,p_model_id:model.id});}else if(item.consumable_id)availability=portalAvailability(s,c,{p_item_type:"consumable",p_consumable_id:item.consumable_id});else continue;const shortage=Math.max(num(item.quantity)-num(availability.available_quantity),0);if(shortage>0&&item.additional_quantity_requested!==true)invalid("additional_quantity_acknowledgement_required");Object.assign(item,{available_quantity_at_submission:availability.available_quantity,shortage_quantity:shortage,availability_snapshot_at:new Date().toISOString(),needs_purchase:shortage>0||item.needs_purchase});}
}
