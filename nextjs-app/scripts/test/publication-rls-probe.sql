-- Synthetic, rollback-only probe. Requires the reviewed local schema and pgTAP.
-- This is SQL role/RLS coverage, not a Supabase Auth/Storage HTTP integration test.
begin;
do $$begin
 if current_database() <> 'synthetic_itam' then raise exception 'disposable_synthetic_database_required'; end if;
end$$;
select no_plan();

select ok(bool_and(c.relrowsecurity),'Sensitive operational tables have RLS enabled')
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname in ('assets','requests','request_items','app_users','customers','customer_portal_users','purchase_request_items');
select ok(not has_table_privilege('anon','public.assets','select'),'Anonymous callers have no direct asset read');
select ok(not has_table_privilege('authenticated','public.assets','select'),'No blanket asset SELECT bypasses financial projection');
select ok(has_column_privilege('authenticated','public.assets','asset_tag','select'),'Authenticated callers can select nonfinancial asset columns');
select ok(not has_column_privilege('authenticated','public.assets','purchase_cost','select'),'Purchase cost is not a direct authenticated column');
select ok(not has_column_privilege('authenticated','public.consumables','unit_cost','select'),'Consumable cost is not a direct authenticated column');
select ok(not has_column_privilege('authenticated','public.purchase_request_items','unit_cost','select'),'Procurement item cost is not a direct authenticated column');
select ok(not has_function_privilege('anon','public.portal_get_request(uuid)','execute'),'Anonymous callers cannot execute portal request lookup');
select ok(not has_function_privilege('anon','public.assets_financial(uuid[])','execute'),'Anonymous callers cannot execute financial lookup');
select ok(has_function_privilege('anon','public.public_asset_by_token(text)','execute'),'Anonymous QR RPC remains callable');
select is((select proargnames from pg_proc where oid='public.public_asset_by_token(text)'::regprocedure),array['p_token','asset_tag','name','status','category','location'],'QR has exactly its documented five output fields');

select throws_ok($$insert into auth.users(id,email) values('de000000-0000-4000-8000-000000000090','closed@fixture.invalid')$$,'22023','staff_registration_closed','Public registration remains closed during the test');
-- Trusted fixture setup follows the source's Auth Admin provisioning claim.
-- This creates pending viewers first; no registration setting or trigger changes.
select set_config('request.jwt.claim.role','service_role',true);
insert into auth.users(id,email) values
 ('de000000-0000-4000-8000-000000000001','manager@fixture.invalid'),
 ('de000000-0000-4000-8000-000000000002','viewer@fixture.invalid'),
 ('de000000-0000-4000-8000-000000000003','requester-a@fixture.invalid'),
 ('de000000-0000-4000-8000-000000000004','requester-b@fixture.invalid'),
 ('de000000-0000-4000-8000-000000000005','peer-a@fixture.invalid');
insert into public.app_users(id,email,full_name,role_id,is_active,approval_status)
select 'de000000-0000-4000-8000-000000000001','manager@fixture.invalid','Synthetic Manager',id,true,'approved' from public.roles where key='it_manager'
on conflict(id) do update set role_id=excluded.role_id,approval_status=excluded.approval_status;
insert into public.app_users(id,email,full_name,role_id,is_active,approval_status)
select 'de000000-0000-4000-8000-000000000002','viewer@fixture.invalid','Synthetic Viewer',id,true,'approved' from public.roles where key='viewer'
on conflict(id) do update set role_id=excluded.role_id,approval_status=excluded.approval_status;
select set_config('request.jwt.claim.sub','de000000-0000-4000-8000-000000000001',true);
insert into public.companies(id,name) values('de000000-0000-4000-8000-000000000010','Synthetic Company');
insert into public.categories(id,name,prefix) values('de000000-0000-4000-8000-000000000011','Synthetic Category','DEMO');
insert into public.locations(id,name,code) values('de000000-0000-4000-8000-000000000013','Synthetic Location','DEMO-RLS-LOCATION');
insert into public.assets(id,asset_tag,qr_token,category_id,company_id,location_id,name,serial_number,purchase_cost)
values('de000000-0000-4000-8000-000000000012','DEMO-RLS-ASSET-1','DEMO-RLS-QR-1','de000000-0000-4000-8000-000000000011','de000000-0000-4000-8000-000000000010','de000000-0000-4000-8000-000000000013','Synthetic Asset','DEMO-RLS-SERIAL-1',99.99);
insert into public.customers(id,name,approval_status) values
 ('de000000-0000-4000-8000-000000000021','Synthetic Customer A','approved'),
 ('de000000-0000-4000-8000-000000000022','Synthetic Customer B','approved');
insert into public.customer_portal_users(id,customer_id,contact_name,portal_role) values
 ('de000000-0000-4000-8000-000000000003','de000000-0000-4000-8000-000000000021','Synthetic Requester A','authorized_requester'),
 ('de000000-0000-4000-8000-000000000004','de000000-0000-4000-8000-000000000022','Synthetic Requester B','authorized_requester'),
 ('de000000-0000-4000-8000-000000000005','de000000-0000-4000-8000-000000000021','Synthetic Peer A','authorized_requester');
insert into public.customer_portal_settings(customer_id,portal_enabled) values
 ('de000000-0000-4000-8000-000000000021',true),('de000000-0000-4000-8000-000000000022',true)
on conflict(customer_id) do update set portal_enabled=true;
insert into public.requests(id,request_number,customer_id,submitted_by,request_source) values
 ('de000000-0000-4000-8000-000000000031','DEMO-RLS-REQUEST-A','de000000-0000-4000-8000-000000000021','de000000-0000-4000-8000-000000000003','client_portal'),
 ('de000000-0000-4000-8000-000000000032','DEMO-RLS-REQUEST-B','de000000-0000-4000-8000-000000000022','de000000-0000-4000-8000-000000000004','client_portal'),
 ('de000000-0000-4000-8000-000000000033','DEMO-RLS-REQUEST-PEER','de000000-0000-4000-8000-000000000021','de000000-0000-4000-8000-000000000005','client_portal');

select set_config('request.jwt.claim.role','authenticated',true);
set local role authenticated;
select is((select purchase_cost from public.assets_financial(array['de000000-0000-4000-8000-000000000012'::uuid])),99.99::numeric,'Approved manager reads cost through financial RPC');
select set_config('request.jwt.claim.sub','de000000-0000-4000-8000-000000000002',true);
select is((select count(*) from public.assets_financial(array['de000000-0000-4000-8000-000000000012'::uuid])),0::bigint,'Viewer financial RPC returns no cost row');
select is((select count(asset_tag) from public.assets where id='de000000-0000-4000-8000-000000000012'),1::bigint,'Viewer retains authorized nonfinancial asset read');
select throws_ok($$select purchase_cost from public.assets$$,'42501',null,'Direct purchase cost read is denied');
select set_config('request.jwt.claim.sub','de000000-0000-4000-8000-000000000003',true);
select is(public.portal_get_request('de000000-0000-4000-8000-000000000031')->>'ok','true','Requester reads their own customer request');
select is(public.portal_get_request('de000000-0000-4000-8000-000000000032')->>'error','not_found','Requester cannot read another customer request');
select is(public.portal_get_request('de000000-0000-4000-8000-000000000033')->>'error','not_found','Requester cannot read a peer request in the same customer');
select is(json_array_length(public.portal_list_requests()->'requests'),1,'Requester list includes only owned requests');
select is((select count(*) from public.requests where id in ('de000000-0000-4000-8000-000000000032','de000000-0000-4000-8000-000000000033')),0::bigint,'Direct RLS read also hides foreign and peer requests');
reset role;
update public.customer_portal_settings set portal_enabled=false where customer_id='de000000-0000-4000-8000-000000000021';
set local role authenticated;
-- The later activity-gate migration withholds portal identity itself, so its
-- current denial contract is not_portal rather than the older portal_disabled.
select is(public.portal_get_request('de000000-0000-4000-8000-000000000031')->>'error','not_portal','Portal switch blocks existing request access');
select is(public.portal_list_requests()->>'error','not_portal','Portal switch blocks request list');
select ok(public.portal_get_request('de000000-0000-4000-8000-000000000031')->'request' is null,'Disabled portal response contains no request payload');
reset role;
delete from public.customer_portal_settings where customer_id='de000000-0000-4000-8000-000000000021';
set local role authenticated;
select is(public.portal_get_request('de000000-0000-4000-8000-000000000031')->>'error','not_portal','Missing portal settings fail closed');
reset role;
set local role anon;
select is((select count(*) from public.public_asset_by_token('DEMO-RLS-QR-1')),1::bigint,'Public QR returns the synthetic active asset');
select throws_ok($$select asset_tag from public.assets$$,'42501',null,'Anonymous direct asset read is denied');
reset role;
select * from finish();
rollback;
