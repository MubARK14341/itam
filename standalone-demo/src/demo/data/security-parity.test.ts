import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { createDemoStore } from "./store";
import { createDemoTransport } from "./transport";
import { DEMO_SUPABASE_URL, DEMO_SUPABASE_ANON_KEY, setDemoAuthScenario } from "./auth";
import { getDemoDashboardData } from "./dashboard";
import { DEMO_PERSONAS, demoId } from "./seed";

async function setup() {
  const store=createDemoStore({memory:true});await store.setActor("it_manager");
  const client=createClient(DEMO_SUPABASE_URL,DEMO_SUPABASE_ANON_KEY,{global:{fetch:createDemoTransport(store)},auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
  return{store,client};
}
function kpis(data:Awaited<ReturnType<typeof getDemoDashboardData>>){if(data.kpis.status==="error")throw new Error("KPI widget unavailable");return data.kpis.data;}
afterEach(()=>vi.useRealTimers());
describe("final source permission, KPI and registration parity",()=>{
  it("permits only admin capability edits and forbids self or admin overrides",async()=>{
    const{store,client}=await setup();
    for(const persona of DEMO_PERSONAS.filter(p=>p.role!=="admin")){
      await store.setActor(persona.id);const before=await store.read();
      expect((await client.rpc("set_role_capability",{p_role_key:"viewer",p_key:"asset.view",p_allowed:false})).data).toEqual({ok:false,error:"not_authorized"});
      expect((await client.rpc("set_user_capability",{p_user:demoId(1,1),p_key:"asset.view",p_state:"deny"})).data).toEqual({ok:false,error:"not_authorized"});
      const after=await store.read();expect(after.tables.role_permissions).toEqual(before.tables.role_permissions);expect(after.tables.user_permissions).toEqual(before.tables.user_permissions);expect(after.generation).toBe(before.generation);
    }
    await store.setActor("admin");await store.transact(store.capture(),s=>{s.tables.app_users.push({...s.tables.app_users.find(u=>u.id===demoId(1,8))!,id:demoId(1,99)});});
    const before=await store.read();
    for(const[p_user,error]of [[demoId(1,8),"cannot_modify_self"],[demoId(1,99),"cannot_modify_admin"]])expect((await client.rpc("set_user_capability",{p_user,p_key:"asset.view",p_state:"deny"})).data).toEqual({ok:false,error});
    expect((await client.rpc("set_role_capability",{p_role_key:"unknown",p_key:"asset.view",p_allowed:true})).data).toEqual({ok:false,error:"not_found"});
    expect((await client.rpc("set_user_capability",{p_user:demoId(1,1),p_key:"unknown",p_state:"allow"})).data).toEqual({ok:false,error:"not_found"});
    expect((await store.read()).tables.user_permissions).toEqual(before.tables.user_permissions);
    expect((await client.rpc("set_role_capability",{p_role_key:"viewer",p_key:"asset.view",p_allowed:false})).data).toEqual({ok:true});
    expect((await client.rpc("set_user_capability",{p_user:demoId(1,1),p_key:"report.export",p_state:"deny"})).data).toEqual({ok:true});
    await store.setActor("viewer");expect((await client.rpc("my_capabilities")).data).not.toContain("asset.view");
    await store.setActor("it_manager");expect((await client.rpc("my_capabilities")).data).not.toContain("report.export");
    await store.setActor("admin");expect((await client.rpc("set_user_capability",{p_user:demoId(1,1),p_key:"report.export",p_state:"inherit"})).data).toEqual({ok:true});
    await store.setActor("it_manager");expect((await client.rpc("my_capabilities")).data).toContain("report.export");
  });
  it("changes staff visibility only for managers, with exact classification and event effects",async()=>{
    const{store,client}=await setup();const id=demoId(31,1);
    await store.transact(store.capture(),s=>{const a=s.tables.request_attachments[0];s.tables.request_attachments.push({...a,id:demoId(31,2),uploaded_by_kind:"portal"},{...a,id:demoId(31,3),classification:"financial"});});
    for(const persona of ["warehouse_manager","technician","viewer","employee","auditor","portal_project_manager"]){await store.setActor(persona);const before=await store.read();expect((await client.rpc("staff_set_request_attachment_visibility",{p_attachment_id:id,p_visible:false})).data).toEqual({ok:false,error:"not_authorized"});const after=await store.read();expect(after.tables.request_attachments).toEqual(before.tables.request_attachments);expect(after.tables.request_events).toEqual(before.tables.request_events);}
    await store.setActor("it_manager");const before=await store.read();
    expect((await client.rpc("staff_set_request_attachment_visibility",{p_attachment_id:demoId(31,2),p_visible:false})).data).toEqual({ok:false,error:"not_allowed"});
    expect((await client.rpc("staff_set_request_attachment_visibility",{p_attachment_id:demoId(31,3),p_visible:true})).data).toEqual({ok:false,error:"financial_visibility_forbidden"});
    expect((await store.read()).tables.request_events).toEqual(before.tables.request_events);
    expect((await client.rpc("staff_set_request_attachment_visibility",{p_attachment_id:id,p_visible:false})).data).toEqual({ok:true});
    const hidden=await store.read();expect(hidden.tables.request_attachments.find(a=>a.id===id)).toMatchObject({visible_to_customer:false,classification:"internal"});
    expect(hidden.tables.request_events.filter(e=>e.event_type==="attachment_visibility_changed")).toEqual([expect.objectContaining({actor_kind:"staff",actor_id:demoId(1,1),message:"demo-guide.pdf",metadata:{attachment_id:id,visible_to_customer:false}})]);
    await store.setActor("portal_project_manager");expect((await client.rpc("portal_list_request_attachments",{p_request_id:demoId(16,13)})).data.attachments.some((a:{id:string})=>a.id===id)).toBe(false);expect((await client.rpc("portal_get_request_attachment_path",{p_attachment_id:id})).error?.code).toBe("42501");
    await store.setActor("admin");expect((await client.rpc("staff_set_request_attachment_visibility",{p_attachment_id:id,p_visible:true})).data).toEqual({ok:true});
    const shown=await store.read();expect(shown.tables.request_attachments.find(a=>a.id===id)).toMatchObject({visible_to_customer:true,classification:"customer_visible"});expect(shown.tables.request_events.filter(e=>e.event_type==="attachment_visibility_changed")).toHaveLength(2);
  });
  it("uses final SQL date, activity and threshold boundaries and updates counters after real SDK mutations",async()=>{
    vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date("2026-10-11T22:30:00.000Z"));
    const{store,client}=await setup(),today="2026-10-12";
    await store.transact(store.capture(),s=>{
      s.tables.assets[0].is_active=false;s.tables.assets[1].archived_at="2026-10-01T00:00:00Z";s.tables.assets[2].location_id=null;s.tables.assets[3].is_active=false;s.tables.assets[3].location_id=null;
      const co=s.tables.consumables[0];s.tables.consumables=[{...co,quantity_on_hand:0,reorder_level:0},{...co,id:demoId(14,2),quantity_on_hand:3,reorder_level:10},{...co,id:demoId(14,3),quantity_on_hand:11,reorder_level:10},{...co,id:demoId(14,4),quantity_on_hand:0,reorder_level:-1},{...co,id:demoId(14,5),quantity_on_hand:0,reorder_level:10,is_active:false}];
      const m=s.tables.maintenance_records[0],ago=(n:number)=>new Date(Date.now()-n*86400000).toISOString();
      s.tables.maintenance_records=[{...m,id:demoId(19,1),status:"open",reported_at:ago(16),technician_id:demoId(1,9),action_taken:"Diagnosis",next_due_date:"2026-10-11"},{...m,id:demoId(19,2),status:"open",reported_at:ago(3),technician_id:null,action_taken:"  ",next_due_date:today},{...m,id:demoId(19,3),status:"open",reported_at:ago(3),technician_id:demoId(1,9),next_due_date:today},{...m,id:demoId(19,4),status:"completed",reported_at:ago(20),technician_id:null},{...m,id:demoId(19,5),status:"in_progress",reported_at:ago(14),technician_id:demoId(1,9),next_due_date:null},{...m,id:demoId(19,6),status:"in_progress",reported_at:new Date(Date.now()-14*86400000-1).toISOString(),technician_id:demoId(1,9),next_due_date:"2026-10-13"}];
      const r=s.tables.requests[0],statuses=["under_review","under_review","under_review","needs_clarification","stock_shortage","auto_provisioning","approved","provisioned","preparing","ready_for_pickup","delivered","partially_returned","overdue","delivered","returned","completed"];
      s.tables.requests=statuses.map((status,i)=>({...r,id:demoId(16,i+1),status,portal_approval_status:i===1?"pending_project_manager":i===2?"rejected_by_project_manager":"not_required",responsible_employee_id:[0,3,15].includes(i)?demoId(1,9):demoId(1,3),return_date:i===10?today:i===11?"2026-10-11":i===12?null:"2026-10-13"}));s.tables.request_events=[];
    });
    const initial=await client.rpc("dashboard_operational_summary");expect(initial.error).toBeNull();expect(initial.data).toMatchObject({assets:{total:117},consumables:{at_risk:1,stockout:2,without_threshold:2},maintenance:{long_open:2,no_action:1,followup:3},requests:{actionable:1,overdue:2,preparation:5,ready_delivery:1,returns_due:2,returned_inspection:1}});
    expect((await client.rpc("request_execute_idempotent",{p_request_id:demoId(16,1),p_operation_type:"approve",p_operation_id:crypto.randomUUID(),p_payload:{}})).error).toBeNull();
    expect((await client.rpc("maintenance_assign_technician",{p_id:demoId(19,2),p_technician_id:demoId(1,9)})).error).toBeNull();
    expect((await client.rpc("consumable_stock_move_idempotent",{p_consumable_id:demoId(14,2),p_type:"in",p_quantity:9,p_operation_id:crypto.randomUUID()})).error).toBeNull();
    const updated=await client.rpc("dashboard_operational_summary");expect(updated.data).toMatchObject({requests:{actionable:0,preparation:6},maintenance:{followup:2},consumables:{at_risk:0}});
    const manager=await getDemoDashboardData(store);expect(kpis(manager).map(k=>[k.id,k.value])).toEqual([["actionableRequests",0],["overdueRequests",2],["maintenanceFollowup",2],["criticalConsumables",0]]);
    await store.setActor("technician");const tech=await getDemoDashboardData(store);expect(kpis(tech).map(k=>[k.id,k.value])).toEqual([["assignedMaintenance",5],["assignedMaintenanceOverdue",1],["assignedRequests",2],["maintenanceFollowup",2]]);expect(kpis(tech)[0].source).toBe("exact_table_count");
    await store.setActor("warehouse_manager");const warehouse=await getDemoDashboardData(store);expect(kpis(warehouse).map(k=>[k.id,k.value])).toEqual([["preparationQueue",6],["readyDelivery",1],["returnsDue",2],["criticalConsumables",0]]);expect(kpis(warehouse)[2]).toMatchObject({period:"current_riyadh_day",href:"/requests?view=returns_due"});
    await store.setActor("auditor");expect(kpis(await getDemoDashboardData(store)).map(k=>[k.id,k.value])).toEqual([["missingLocation",1],["activeAssets",117],["maintenanceFollowup",2],["criticalConsumables",0]]);
  });
  it("returns the source four KPI definitions for each dashboard role",async()=>{
    const{store}=await setup();const expected={admin:["actionableRequests","overdueRequests","maintenanceFollowup","criticalConsumables"],it_manager:["actionableRequests","overdueRequests","maintenanceFollowup","criticalConsumables"],technician:["assignedMaintenance","assignedMaintenanceOverdue","assignedRequests","maintenanceFollowup"],warehouse_manager:["preparationQueue","readyDelivery","returnsDue","criticalConsumables"],viewer:["activeAssets","availableAssets","inMaintenanceAssets","actionableRequests"],auditor:["missingLocation","activeAssets","maintenanceFollowup","criticalConsumables"]};
    for(const[role,ids]of Object.entries(expected)){await store.setActor(role);const data=await getDemoDashboardData(store);expect(kpis(data).map(k=>k.id)).toEqual(ids);expect(kpis(data).every(k=>k.financial===false&&Number.isInteger(k.value))).toBe(true);}
  });
  it("reads missing customer settings defaults without writes and keeps missing or inactive portals closed",async()=>{
    const{store,client}=await setup();const saved=await client.rpc("customer_save_atomic",{p_input:{name:"New settings customer"}});expect(saved.error).toBeNull();const id=saved.data.id,before=await store.read();
    const settings=await client.rpc("get_customer_portal_settings",{p_customer_id:id});expect(settings.data.settings).toMatchObject({customer_id:id,portal_enabled:false,allow_rental_requests:true,allow_purchase_requests:true,allow_maintenance_requests:true,allow_custom_requests:true,allow_custom_item_requests:true,allow_attachments:true,require_project_manager_approval:false});expect((await store.read()).tables.customer_portal_settings).toEqual(before.tables.customer_portal_settings);
    await store.transact(store.capture(),s=>{s.tables.customer_portal_settings=s.tables.customer_portal_settings.filter(r=>r.customer_id!==demoId(3,1));});await store.setActor("portal_project_manager");expect((await client.rpc("portal_get_context")).data).toMatchObject({ok:true,portal_enabled:false,disabled:true});expect((await client.rpc("portal_list_catalog")).error?.message).toBe("portal_disabled");
    await store.setActor("it_manager");expect((await client.rpc("update_customer_portal_settings",{p_customer_id:id,p_portal_enabled:true})).data).toEqual({ok:true});expect((await client.rpc("get_customer_portal_settings",{p_customer_id:id})).data.settings).toMatchObject({portal_enabled:true,allow_custom_requests:true});
    expect((await client.rpc("customer_set_active",{p_customer_id:id,p_is_active:false})).data).toEqual({ok:true});const inactiveBefore=await store.read();expect((await client.rpc("get_customer_portal_settings",{p_customer_id:id})).data.settings.portal_enabled).toBe(false);expect((await store.read()).tables.customer_portal_settings).toEqual(inactiveBefore.tables.customer_portal_settings);
  });
  it("registers pending staff with server-selected role and complete profile metadata",async()=>{
    const{store,client}=await setup();await store.setActor(null);const before=await store.read();
    const response=await client.auth.signUp({email:"staff-new@demo.invalid",password:"Local-Only123!",options:{data:{full_name:"Local staff",phone:"0501234567",department_id:demoId(6,1),registration_note:"New local profile",requested_role:"admin"}}});expect(response.error).toBeNull();expect(response.data.session).toBeNull();const after=await store.read();expect(after.actorId).toBeNull();expect(after.tables.app_users).toHaveLength(before.tables.app_users.length+1);expect(after.tables.app_users.find(u=>u.id===response.data.user!.id)).toMatchObject({email:"staff-new@demo.invalid",full_name:"Local staff",phone:"0501234567",department_id:demoId(6,1),registration_note:"New local profile",role_key:"viewer",requested_role:"employee",approval_status:"pending",is_active:true});expect(after.tables.customer_portal_users).toEqual(before.tables.customer_portal_users);expect(JSON.stringify(after)).not.toContain("Local-Only123!");
  });
  it("atomically enforces staff mode, domain, capacity and invite counters",async()=>{
    const{store,client}=await setup();await store.setActor(null);const args={email:"blocked@demo.invalid",password:"Local-Only123!"};
    await store.transact(store.capture(),s=>{s.tables.registration_settings[0].mode="closed";});expect((await client.auth.signUp(args)).error?.message).toBe("staff_registration_closed");
    await store.transact(store.capture(),s=>Object.assign(s.tables.registration_settings[0],{mode:"open_with_approval",allowed_domains:["company.invalid"]}));expect((await client.auth.signUp(args)).error?.message).toBe("staff_registration_domain_not_allowed");
    await store.transact(store.capture(),s=>Object.assign(s.tables.registration_settings[0],{mode:"gradual",allowed_domains:[],remaining_slots:1}));
    const responses=await Promise.all(["one","two"].map(n=>client.auth.signUp({...args,email:`staff-${n}@demo.invalid`})));expect(responses.filter(r=>r.error===null)).toHaveLength(1);expect(responses.filter(r=>r.error?.message==="staff_registration_capacity_exhausted")).toHaveLength(1);expect((await store.read()).tables.registration_settings[0].remaining_slots).toBe(0);
    await store.transact(store.capture(),s=>Object.assign(s.tables.registration_settings[0],{mode:"invite_only"}));expect((await client.auth.signUp({...args,email:"no-invite@demo.invalid"})).error?.message).toBe("staff_registration_invite_required");
    const invited=await client.auth.signUp({...args,email:"staff-invited@demo.invalid",options:{data:{invite_code:"demo-staff"}}});expect(invited.error).toBeNull();const after=await store.read();expect(after.tables.registration_invites[0].used_count).toBe(1);expect(after.tables.registration_invite_uses).toEqual([expect.objectContaining({user_id:invited.data.user!.id,invite_id:demoId(21,1)})]);expect(after.tables.app_users.find(u=>u.id===invited.data.user!.id)).toMatchObject({requested_role:"employee",approval_status:"pending"});
  });
  it("registers an open portal identity as a pending customer and PM without any staff profile",async()=>{
    const{store,client}=await setup();await store.setActor(null);const before=await store.read(),args={email:"portal-new@demo.invalid",password:"Local-Only123!",options:{data:{user_type:"portal",full_name:"Local PM",phone:"0501234567",company_name:"New local customer",city:"Riyadh"}}};
    const response=await client.auth.signUp(args);expect(response.error).toBeNull();expect(response.data.session).toBeNull();const after=await store.read(),profile=after.tables.customer_portal_users.find(u=>u.id===response.data.user!.id)!;expect(after.actorId).toBeNull();expect(after.tables.app_users).toEqual(before.tables.app_users);expect(profile).toMatchObject({contact_name:"Local PM",phone:"0501234567",portal_role:"project_manager",is_active:true});expect(after.tables.customers.find(c=>c.id===profile.customer_id)).toMatchObject({name:"New local customer",email:args.email,city:"Riyadh",approval_status:"pending",created_by:profile.id});expect(after.tables.customer_portal_settings).toEqual(before.tables.customer_portal_settings);
    expect((await client.auth.signUp({...args,email:"portal-no-phone@demo.invalid",options:{data:{...args.options.data,phone:" "}}})).error?.message).toBe("phone is required for portal registration");expect((await store.read()).tables.customers).toEqual(after.tables.customers);
  });
  it("claims portal invite use once per new identity with concurrent exhaustion and rollback",async()=>{
    const{store,client}=await setup();await store.setActor(null);await store.transact(store.capture(),s=>{s.tables.customer_portal_invites[0].max_uses=1;});const before=await store.read(),args={password:"Local-Only123!",options:{data:{user_type:"portal",invite_code:"demo-portal",full_name:"Invited contact",phone:"0501234567"}}};
    const results=await Promise.all(["one","two"].map(n=>client.auth.signUp({...args,email:`portal-invited-${n}@demo.invalid`})));expect(results.filter(r=>r.error===null)).toHaveLength(1);expect(results.filter(r=>r.error?.message==="invalid_portal_invite")).toHaveLength(1);const success=results.find(r=>r.error===null)!,after=await store.read();expect(after.tables.app_users).toEqual(before.tables.app_users);expect(after.tables.customers).toEqual(before.tables.customers);expect(after.tables.customer_portal_users).toHaveLength(before.tables.customer_portal_users.length+1);expect(after.tables.customer_portal_users.find(u=>u.id===success.data.user!.id)).toMatchObject({customer_id:demoId(3,1),portal_role:"authorized_requester",contact_name:"Invited contact"});expect(after.tables.customer_portal_invites[0].used_count).toBe(1);
    expect((await client.auth.signUp({...args,email:success.data.user!.email!})).error?.message).toBe("Email already registered locally");expect((await store.read()).tables.customer_portal_users).toEqual(after.tables.customer_portal_users);
  });
  it("denies direct registration DML and enforces the explicit settings capability on its RPCs",async()=>{
    const{store,client}=await setup();const before=await store.read();
    for(const table of ["registration_settings","registration_invites"]){
      expect((await client.from(table).update({is_active:false,mode:"closed"})).error?.message).toBe("atomic_rpc_required");
      expect((await client.from(table).insert({id:crypto.randomUUID(),mode:"closed",code:"FORGED"})).error?.message).toBe("atomic_rpc_required");
      expect((await client.from(table).delete()).error?.message).toBe("atomic_rpc_required");
      expect((await store.read()).tables[table]).toEqual(before.tables[table]);
    }
    await store.setActor("admin");expect((await client.rpc("set_user_capability",{p_user:demoId(1,1),p_key:"settings.manage",p_state:"deny"})).data).toEqual({ok:true});
    await store.setActor("it_manager");expect((await client.rpc("registration_settings_update_atomic",{p_input:{mode:"closed"}})).error?.message).toBe("capability_not_authorized");expect((await store.read()).tables.registration_settings).toEqual(before.tables.registration_settings);
    await store.setActor("admin");expect((await client.rpc("set_user_capability",{p_user:demoId(1,1),p_key:"settings.manage",p_state:"inherit"})).data).toEqual({ok:true});
    await store.setActor("it_manager");expect((await client.rpc("registration_settings_update_atomic",{p_input:{mode:"closed"}})).data).toEqual({ok:true});expect((await store.read()).tables.registration_settings[0].mode).toBe("closed");
  });
  it("denies generic table writes for inactive, unapproved and simulated pending accounts inside the transaction",async()=>{
    for(const boundary of ["inactive","pending","rejected","overlay"]){
      const{store,client}=await setup();
      if(boundary==="overlay")await setDemoAuthScenario("pending",store);else await store.transact(store.capture(),s=>{const user=s.tables.app_users.find(u=>u.id===demoId(1,1))!;if(boundary==="inactive")user.is_active=false;else user.approval_status=boundary;});
      const before=await store.read();
      expect((await client.from("inventory_settings").upsert({id:"main",default_reorder_level:999})).error?.message).toBe("account_not_approved");
      expect((await client.from("companies").insert({name:"Forbidden company"})).error?.message).toBe("account_not_approved");
      const after=await store.read();expect(after.tables.inventory_settings).toEqual(before.tables.inventory_settings);expect(after.tables.companies).toEqual(before.tables.companies);
    }
  });
  it("enforces new asset references, serial, immutable creator and canonical status without partial writes",async()=>{
    const{store,client}=await setup(),valid={category_id:demoId(4,1),company_id:demoId(2,1),location_id:demoId(5,1),serial_number:"GUARD-NEW",name:"Guard asset"};const before=await store.read();
    for(const[patch,error]of [[{company_id:null},"asset_company_required"],[{location_id:null},"asset_location_required"],[{serial_number:" "},"asset_serial_required"],[{status:"rented"},"asset_primary_status_invalid"]]as const){expect((await client.rpc("asset_create_atomic",{p_input:{...valid,...patch}})).error?.message).toBe(error);expect((await store.read()).tables.assets).toEqual(before.tables.assets);expect((await store.read()).tables.asset_movements).toEqual(before.tables.asset_movements);}
    const created=await client.rpc("asset_create_atomic",{p_input:valid});expect(created.error).toBeNull();expect((await store.read()).tables.assets.find(a=>a.id===created.data.id)).toMatchObject({...valid,status:"available",created_by:demoId(1,1)});
    const baseline=await store.read(),id=created.data.id;
    for(const[patch,error]of [[{company_id:null},"asset_company_cannot_be_cleared"],[{location_id:null},"asset_location_cannot_be_cleared"],[{created_by:demoId(1,9)},"asset_creator_immutable"],[{status:"sold"},"asset_primary_status_invalid"]]as const){expect((await client.rpc("asset_update_atomic",{p_asset_id:id,p_input:patch})).error?.message).toBe(error);expect((await store.read()).tables.assets).toEqual(baseline.tables.assets);expect((await store.read()).tables.asset_movements).toEqual(baseline.tables.asset_movements);}
    expect((await client.rpc("asset_update_atomic",{p_asset_id:id,p_input:{name:"Valid edit",id:demoId(11,999),qr_token:"FORGED",created_at:"FORGED"}})).data).toEqual({ok:true});const edited=(await store.read()).tables.assets.find(a=>a.id===id)!;expect(edited).toMatchObject({name:"Valid edit",created_by:demoId(1,1),company_id:valid.company_id,location_id:valid.location_id});expect(edited.qr_token).toBe(baseline.tables.assets.find(a=>a.id===id)?.qr_token);expect(edited.created_at).not.toBe("FORGED");
  });
  it("keeps delivery assets reserved for rental and custody, and archives completed sales",async()=>{
    for(const type of ["rental","internal","sale"]){
      const{store,client}=await setup(),id=demoId(16,7);await store.transact(store.capture(),s=>{const r=s.tables.requests.find(r=>r.id===id)!;r.request_type=type;if(type==="internal"){r.beneficiary_type="employee";r.beneficiary_employee_id=demoId(8,3);}});
      const allocation=await client.rpc("request_asset_allocation_summary",{p_request_id:id}),assetId=allocation.data[0].asset_id,before=await store.read();
      expect((await client.rpc("request_deliver_with_proof",{p_id:id,p_operation_id:crypto.randomUUID(),p_proof:{method:"acknowledgement",receiver_name:"Local receiver",acknowledged:true,verified_asset_ids:[assetId]}})).error).toBeNull();
      const after=await store.read(),asset=after.tables.assets.find(a=>a.id===assetId)!;expect(asset.status).toBe("reserved");expect(after.tables.requests.find(r=>r.id===id)?.status).toBe(type==="sale"?"completed":"delivered");
      if(type==="sale"){expect(asset.is_active).toBe(false);expect(asset.archived_at).toEqual(expect.any(String));expect((await client.rpc("dashboard_operational_summary")).data.assets.total).toBe(before.tables.assets.length-1);expect((await client.rpc("public_asset_by_token",{p_token:asset.qr_token})).data).toEqual([]);}
      if(type==="internal"){expect(asset.assigned_to_employee_id).toBe(demoId(8,3));expect(after.tables.asset_assignments.filter(a=>a.asset_id===assetId&&a.status==="active")).toEqual([expect.objectContaining({employee_id:demoId(8,3)})]);}
    }
  });
});
