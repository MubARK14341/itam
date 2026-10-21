import { test, expect, chooseRole, snapshot, rpc, readTable, row, id, successful, denied, mutationResult, auditContext, type Row } from './helpers';

const portalPickup = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
const portalReturn = new Date(Date.now() + 8 * 86400000).toISOString().slice(0, 10);

// These are real-browser tests of the demo SDK/IndexedDB boundary. They are
// separate from UI action coverage: RPC success cannot prove a button works.
test.beforeEach(async ({ page, baseURL }) => {
  if (!baseURL || !['127.0.0.1', 'localhost'].includes(new URL(baseURL).hostname)) {
    throw new Error('SDK/IndexedDB audit uses development modules on the explicit local demo only.');
  }
  await chooseRole(page, 'it_manager');
});

test('nonfinancial role denies direct financial columns/RPC and role switch removes privileged results', async ({ page }, info) => {
  const manager = await rpc(page, 'assets_financial', { p_ids: [id(11, 1)] });
  expect(manager.error).toBeNull();
  expect(manager.data).toEqual(expect.arrayContaining([expect.objectContaining({ id: id(11, 1), purchase_cost: expect.any(Number) })]));
  for (const persona of ['employee', 'warehouse_manager', 'technician', 'auditor'] as const) {
    await chooseRole(page, persona);
    denied(await readTable(page, 'assets', 'id,purchase_cost'));
    const restricted = await rpc(page, 'assets_financial', { p_ids: [id(11, 1)] });
    expect(restricted.error).toBeNull(); expect(restricted.data).toEqual([]);
  }
  for (const persona of ['portal_project_manager', 'portal_requester', 'portal_receiver'] as const) {
    await chooseRole(page, persona);
    denied(await readTable(page, 'assets', 'id,purchase_cost'));
    denied(await rpc(page, 'assets_financial', { p_ids: [id(11, 1)] }));
  }
  await chooseRole(page, 'viewer');
  const columnResult = await readTable(page, 'assets', 'id,purchase_cost');
  const financialResult = await rpc(page, 'assets_financial', { p_ids: [id(11, 1)] });
  denied(columnResult);
  // The canonical SQL function filters on is_financial_viewer and returns no
  // rows; direct restricted column selection raises a permission error.
  expect(financialResult.error).toBeNull(); expect(financialResult.data).toEqual([]);
  const visible = await readTable(page, 'assets', 'id,name');
  expect(visible.error).toBeNull();
  expect(JSON.stringify(visible.data)).not.toContain('purchase_cost');
  await page.goto(`/assets/${id(11, 1)}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.locator('#asset-sections-tab-financial')).toHaveCount(0);
  await mutationResult(info, 'financial role switch', { financialRpcRows: 0, directColumnDenied: true, financialTabCount: 0 }, { financialResult, columnResult, financialTabCount: await page.locator('#asset-sections-tab-financial').count() });
});

test('employee and portal reads remain scoped to the actual actor/customer', async ({ page }) => {
  await chooseRole(page, 'employee');
  const own = await rpc(page, 'employee_my_assets');
  expect(own.error).toBeNull();
  expect(Array.isArray(own.data)).toBe(true);
  expect((own.data as unknown[]).length, 'The employee must have seeded owned assets; an empty result cannot prove ownership.').toBeGreaterThan(0);
  const direct = await readTable(page, 'asset_assignments', 'id,employee_id');
  expect(direct.error).toBeNull();
  expect(direct.data).toEqual(expect.arrayContaining([expect.objectContaining({ employee_id: id(8, 2) })]));
  for (const assignment of direct.data as Array<{ employee_id: string }>) expect(assignment.employee_id).toBe(id(8, 2));
  await chooseRole(page, 'portal_requester');
  const state = await snapshot(page);
  const other = state.tables.requests.find(request => request.customer_id === id(3, 2));
  expect(other, 'Seed must contain another customer, otherwise this denial is vacuous.').toBeDefined();
  denied(await rpc(page, 'portal_get_request', { p_request_id: other!.id }));
  denied(await readTable(page, 'assets', 'id,name'));
});

test('stock operation retry changes balance and ledger once; altered payload and overspend preserve state', async ({ page }, info) => {
  const target = id(14, 3), operation = crypto.randomUUID();
  const before = await snapshot(page), initial = Number(row(before, 'consumables', target).quantity_on_hand);
  expect(initial).toBeGreaterThan(2);
  const params = { p_consumable_id: target, p_type: 'out', p_quantity: 2, p_reason: 'DEMO QA issue', p_unit_cost: null, p_supplier_id: null, p_invoice_number: null, p_invoice_date: null, p_employee_id: id(8, 2), p_department_id: null, p_operation_id: operation };
  const first = await rpc(page, 'consumable_stock_move_idempotent', params); successful(first);
  const committed = await snapshot(page);
  successful(await rpc(page, 'consumable_stock_move_idempotent', params));
  denied(await rpc(page, 'consumable_stock_move_idempotent', { ...params, p_quantity: 3 }));
  denied(await rpc(page, 'consumable_stock_move_idempotent', { ...params, p_operation_id: crypto.randomUUID(), p_quantity: initial + 1 }));
  const after = await snapshot(page);
  expect(row(after, 'consumables', target).quantity_on_hand).toBe(initial - 2);
  expect(after.tables.consumable_transactions.length).toBe(before.tables.consumable_transactions.length + 1);
  expect(after.tables.consumable_transactions).toEqual(committed.tables.consumable_transactions);
  expect(after.tables.consumables).toEqual(committed.tables.consumables);
  await page.reload();
  expect(row(await snapshot(page), 'consumables', target).quantity_on_hand).toBe(initial - 2);
  await mutationResult(info, 'idempotent stock issue', { initial, final: initial - 2, addedTransactions: 1 }, { initial, final: row(after, 'consumables', target).quantity_on_hand, addedTransactions: after.tables.consumable_transactions.length - before.tables.consumable_transactions.length });
});

test('goods receipt tracking is exact and idempotent with no stock effect; separate stock movement adds inventory once', async ({ page }, info) => {
  const before = await snapshot(page), request = id(23, 3), item = id(24, 3);
  successful(await rpc(page, 'procurement_record_external_document', {
    p_purchase_request_id: request, p_purchase_request_item_id: item, p_document_type: 'goods_receipt',
    p_source_system: 'DEMO_QA', p_external_reference: 'DEMO-GR-QA-001', p_document_status: 'recorded',
    p_stock_transaction_id: null, p_metadata: {}, p_operation_id: crypto.randomUUID(),
  }));
  const referenced = await snapshot(page);
  expect(referenced.tables.assets).toEqual(before.tables.assets);
  expect(referenced.tables.consumables).toEqual(before.tables.consumables);
  expect(referenced.tables.consumable_transactions).toEqual(before.tables.consumable_transactions);
  expect(row(referenced, 'purchase_request_items', item).received_quantity).toBe(row(before, 'purchase_request_items', item).received_quantity);
  const params = { p_item_id: item, p_qty: 1, p_operation_id: crypto.randomUUID() };
  denied(await rpc(page, 'purchase_request_item_receive_idempotent', params));
  expect(row(await snapshot(page), 'purchase_request_items', item).received_quantity).toBe(row(before, 'purchase_request_items', item).received_quantity);
  // The requester/approver must not receive the same purchase. The technician
  // is the seeded independent receiver; the manager owns financial stock entry.
  await chooseRole(page, 'technician');
  successful(await rpc(page, 'purchase_request_item_receive_idempotent', params));
  const committed = await snapshot(page);
  successful(await rpc(page, 'purchase_request_item_receive_idempotent', params));
  denied(await rpc(page, 'purchase_request_item_receive_idempotent', { ...params, p_qty: 2 }));
  denied(await rpc(page, 'purchase_request_item_receive_idempotent', { ...params, p_operation_id: crypto.randomUUID(), p_qty: 100 }));
  const after = await snapshot(page);
  expect(row(after, 'purchase_request_items', item).received_quantity).toBe(Number(row(before, 'purchase_request_items', item).received_quantity) + 1);
  expect(after.tables.assets).toEqual(before.tables.assets);
  expect(after.tables.consumables).toEqual(before.tables.consumables);
  expect(after.tables.consumable_transactions).toEqual(before.tables.consumable_transactions);
  expect(after.tables.assets).toEqual(committed.tables.assets);
  expect(after.tables.consumables).toEqual(committed.tables.consumables);
  expect(after.tables.purchase_request_items).toEqual(committed.tables.purchase_request_items);
  await chooseRole(page, 'it_manager');
  const stockParams = { p_consumable_id: id(14, 3), p_type: 'in', p_quantity: 1, p_reason: 'Physical stock receipt', p_unit_cost: 54, p_supplier_id: id(7, 1), p_invoice_number: 'DEMO-STOCK-QA', p_invoice_date: '2027-01-20', p_employee_id: null, p_department_id: null, p_operation_id: crypto.randomUUID() };
  successful(await rpc(page, 'consumable_stock_move_idempotent', stockParams));
  successful(await rpc(page, 'consumable_stock_move_idempotent', stockParams));
  const stocked = await snapshot(page);
  expect(row(stocked, 'consumables', id(14, 3)).quantity_on_hand).toBe(Number(row(before, 'consumables', id(14, 3)).quantity_on_hand) + 1);
  expect(stocked.tables.consumable_transactions.length).toBe(before.tables.consumable_transactions.length + 1);
  await mutationResult(info, 'GR tracking then separate physical stock receipt', { grStockDelta: 0, receivedDelta: 1, physicalStockDelta: 1, physicalTransactions: 1 }, { grStockDelta: Number(row(after, 'consumables', id(14, 3)).quantity_on_hand) - Number(row(before, 'consumables', id(14, 3)).quantity_on_hand), receivedDelta: Number(row(after, 'purchase_request_items', item).received_quantity) - Number(row(before, 'purchase_request_items', item).received_quantity), physicalStockDelta: Number(row(stocked, 'consumables', id(14, 3)).quantity_on_hand) - Number(row(before, 'consumables', id(14, 3)).quantity_on_hand), physicalTransactions: stocked.tables.consumable_transactions.length - before.tables.consumable_transactions.length });
});

test('portal atomic retry creates complete items once and invalid request leaves no partial draft', async ({ page }, info) => {
  await chooseRole(page, 'portal_requester');
  const before = await snapshot(page), operation = crypto.randomUUID();
  const input = {
    project_name: 'DEMO QA project', project_city: 'Riyadh', contact_phone: '0500000100', contact_email: 'qa@demo.invalid',
    request_type: 'rental', pickup_date: portalPickup, return_date: portalReturn, notes: 'Synthetic workflow',
    items: [{ requested_kind: 'existing_asset', requested_description: 'Laptop', requested_category: 'Laptop', quantity: 2, preferred_model: null, accept_alternative: true, needs_purchase: false, category_key: 'laptop', preferred_company_id: id(2, 1), model_id: id(9, 1), consumable_id: null, additional_quantity_requested: false }],
  };
  const first = await rpc(page, 'portal_create_request_atomic', { p_operation_id: operation, p_input: input }); successful(first);
  expect(first.data).toMatchObject({ id: expect.any(String) });
  const target = (first.data as { id: string }).id;
  const second = await rpc(page, 'portal_create_request_atomic', { p_operation_id: operation, p_input: input }); successful(second);
  expect(second.data).toMatchObject({ id: target });
  denied(await rpc(page, 'portal_create_request_atomic', { p_operation_id: operation, p_input: { ...input, project_name: 'Changed payload' } }));
  const committed = await snapshot(page);
  denied(await rpc(page, 'portal_create_request_atomic', { p_operation_id: crypto.randomUUID(), p_input: { ...input, items: [{ ...input.items[0], quantity: -1 }] } }));
  const after = await snapshot(page);
  expect(after.tables.requests.length).toBe(before.tables.requests.length + 1);
  expect(after.tables.request_items.filter(item => item.request_id === target)).toHaveLength(1);
  expect(row(after, 'requests', target).creation_complete).toBe(true);
  expect(after.tables.requests).toEqual(committed.tables.requests);
  expect(after.tables.request_items).toEqual(committed.tables.request_items);
  await mutationResult(info, 'atomic portal draft', { newRequests: 1, newItems: 1, creationComplete: true }, { newRequests: after.tables.requests.length - before.tables.requests.length, newItems: after.tables.request_items.length - before.tables.request_items.length, creationComplete: row(after, 'requests', target).creation_complete });
});

test('unknown RPC and hostile transport target fail closed without a native request', async ({ page }) => {
  const unknown = await rpc(page, 'demo_qa_unknown_rpc');
  expect(unknown.error?.code).toBe('DEMO_UNSUPPORTED_OPERATION');
  const result = await page.evaluate(async () => {
    const modulePath = '/src/demo/data/index.ts';
    const data = await import(modulePath);
    const fetch = data.createDemoTransport(data.getDemoStore());
    const response = await fetch('https://example.com/rest/v1/assets');
    return { status: response.status, body: await response.json() };
  });
  expect(result.status).toBe(403);
  expect(result.body).toMatchObject({ code: 'DEMO_NETWORK_DENIED' });
});

test('stocktake decisions cannot be overwritten and apply closes the submitted review atomically', async ({ page }, info) => {
  const take = id(26, 2), before = await snapshot(page);
  successful(await rpc(page, 'stocktake_submit', { p_stocktake_id: take, p_operation_id: crypto.randomUUID() }));
  const submitted = await snapshot(page);
  const variances = submitted.tables.stocktake_items.filter(item => item.stocktake_id === take && item.observation_status === 'missing');
  expect(variances.length, 'The rejection oracle requires actual unresolved variances.').toBeGreaterThan(0);
  denied(await rpc(page, 'stocktake_apply_adjustments', { p_stocktake_id: take, p_operation_id: crypto.randomUUID() }));
  denied(await rpc(page, 'stocktake_review', { p_stocktake_id: take, p_decision: 'approved', p_reason: 'No alternate approval API', p_operation_id: crypto.randomUUID() }));
  expect((await snapshot(page)).tables.stocktakes).toEqual(submitted.tables.stocktakes);
  expect((await snapshot(page)).tables.stocktake_items).toEqual(submitted.tables.stocktake_items);
  const decision = { p_stocktake_id: take, p_item_id: variances[0].id, p_decision: 'keep_current', p_note: 'Retain current custody after review', p_operation_id: crypto.randomUUID() };
  denied(await rpc(page, 'stocktake_decide_item', { ...decision, p_note: '' }));
  successful(await rpc(page, 'stocktake_decide_item', decision));
  const decided = await snapshot(page);
  successful(await rpc(page, 'stocktake_decide_item', decision));
  denied(await rpc(page, 'stocktake_decide_item', { ...decision, p_decision: 'approve_correction', p_operation_id: crypto.randomUUID() }));
  expect((await snapshot(page)).tables.stocktake_items).toEqual(decided.tables.stocktake_items);
  expect((await snapshot(page)).tables.stocktake_events).toEqual(decided.tables.stocktake_events);
  for (const item of variances.slice(1)) successful(await rpc(page, 'stocktake_decide_item', { ...decision, p_item_id: item.id, p_operation_id: crypto.randomUUID() }));
  const apply = { p_stocktake_id: take, p_operation_id: crypto.randomUUID() };
  successful(await rpc(page, 'stocktake_apply_adjustments', apply));
  const completed = await snapshot(page);
  successful(await rpc(page, 'stocktake_apply_adjustments', apply));
  expect(row(completed, 'stocktakes', take)).toMatchObject({ status: 'completed', review_state: 'approved', locked_at: expect.any(String) });
  expect(completed.tables.assets).toEqual(before.tables.assets);
  expect(completed.tables.asset_movements).toEqual(before.tables.asset_movements);
  expect((await snapshot(page)).tables.stocktake_events).toEqual(completed.tables.stocktake_events);
  await page.reload(); expect(row(await snapshot(page), 'stocktakes', take).status).toBe('completed');
  await mutationResult(info, 'stocktake submitted review closure', { variances: variances.length, replacedDecisions: 0, inventoryDelta: 0, completed: true }, { variances: variances.length, replacedDecisions: 0, inventoryDelta: 0, completed: row(completed, 'stocktakes', take).status === 'completed' });
});

test('purchase cancellation is restricted to a manager or the requester of a draft', async ({ page }) => {
  await chooseRole(page, 'warehouse_manager');
  const before = await snapshot(page);
  denied(await rpc(page, 'purchase_request_set_status', { p_id: id(23, 1), p_to: 'cancelled', p_operation_id: crypto.randomUUID() }));
  denied(await rpc(page, 'purchase_request_set_status', { p_id: id(23, 3), p_to: 'cancelled', p_operation_id: crypto.randomUUID() }));
  expect((await snapshot(page)).tables.purchase_requests).toEqual(before.tables.purchase_requests);
  successful(await rpc(page, 'purchase_requests_create_from_shortages', { p_items: [{ consumable_id: id(14, 3), quantity: 1, supplier_id: id(7, 1) }], p_operation_id: crypto.randomUUID() }));
  const created = await snapshot(page), own = created.tables.purchase_requests.filter(request => !before.tables.purchase_requests.some(prior => prior.id === request.id));
  expect(own).toHaveLength(1); expect(own[0]).toMatchObject({ status: 'draft', requested_by: id(1, 3) });
  successful(await rpc(page, 'purchase_request_set_status', { p_id: own[0].id, p_to: 'cancelled', p_operation_id: crypto.randomUUID() }));
  await chooseRole(page, 'it_manager');
  successful(await rpc(page, 'purchase_request_set_status', { p_id: id(23, 2), p_to: 'cancelled', p_operation_id: crypto.randomUUID() }));
  const after = await snapshot(page);
  expect(row(after, 'purchase_requests', String(own[0].id)).status).toBe('cancelled');
  expect(row(after, 'purchase_requests', id(23, 2)).status).toBe('cancelled');
  expect(after.tables.consumables).toEqual(before.tables.consumables);
  expect(after.tables.consumable_transactions).toEqual(before.tables.consumable_transactions);
});

test('maintenance requires an operation ID and closure evidence without partial writes', async ({ page }) => {
  const record = id(19, 1), before = await snapshot(page);
  denied(await rpc(page, 'maintenance_update_safe', { p_id: record, p_input: { priority: 'high' } }));
  denied(await rpc(page, 'maintenance_update_safe', { p_id: record, p_input: { status: 'completed', workflow_stage: 'completed' }, p_operation_id: crypto.randomUUID() }));
  const deniedState = await snapshot(page);
  expect(deniedState.tables.maintenance_records).toEqual(before.tables.maintenance_records);
  expect(deniedState.tables.assets).toEqual(before.tables.assets);
  expect(deniedState.tables.asset_movements).toEqual(before.tables.asset_movements);
  const update = { p_id: record, p_input: { priority: 'low', diagnosis: 'Awaiting bench diagnosis' }, p_operation_id: crypto.randomUUID() };
  successful(await rpc(page, 'maintenance_update_safe', update));
  const committed = await snapshot(page);
  successful(await rpc(page, 'maintenance_update_safe', update));
  denied(await rpc(page, 'maintenance_update_safe', { ...update, p_input: { priority: 'high' } }));
  expect((await snapshot(page)).tables.maintenance_records).toEqual(committed.tables.maintenance_records);
  expect(row(committed, 'maintenance_records', record)).toMatchObject({ priority: 'low', status: 'open' });
});

test('allocated high-value device requires an independent second approval and strong proof remains blocked', async ({ page }, info) => {
  const request = id(16, 7), initial = await snapshot(page);
  const allocated = initial.tables.request_items.find(item => item.request_id === request && item.asset_id);
  expect(allocated, 'A real ready request with an allocated device is required.').toBeDefined();
  successful(await rpc(page, 'asset_update_atomic', { p_asset_id: allocated!.asset_id, p_input: { purchase_cost: 12000 }, p_operation_id: crypto.randomUUID() }));
  const requirements = await rpc(page, 'request_delivery_requirements', { p_request_id: request });
  expect(requirements.error).toBeNull();
  expect(requirements.data).toMatchObject({ risk_level: 'high', second_approval_required: true, second_approval_complete: false });
  denied(await rpc(page, 'request_secondary_approve', { p_id: request, p_reason: 'Independent review required', p_operation_id: crypto.randomUUID() }));
  await chooseRole(page, 'admin');
  const approval = { p_id: request, p_reason: 'Independent review of high-value device', p_operation_id: crypto.randomUUID() };
  successful(await rpc(page, 'request_secondary_approve', approval));
  const approved = await snapshot(page);
  successful(await rpc(page, 'request_secondary_approve', approval));
  expect((await snapshot(page)).tables.requests).toEqual(approved.tables.requests);
  expect(row(approved, 'requests', request).second_approved_by).toBe(id(1, 8));
  await chooseRole(page, 'technician');
  const beforeDelivery = await snapshot(page);
  const delivery = await rpc(page, 'request_deliver_with_proof', { p_id: request, p_proof: { method: 'signature', receiver_name: 'Demo independent receiver', acknowledged: true, verified_asset_ids: [allocated!.asset_id], delivery_notes: 'Final source requires strong proof support' }, p_operation_id: crypto.randomUUID() });
  denied(delivery); expect(delivery.error?.message).toBe('strong_proof_required');
  const after = await snapshot(page);
  for (const table of ['requests', 'request_items', 'assets', 'asset_movements', 'consumables', 'consumable_transactions', 'request_delivery_proofs']) expect(after.tables[table]).toEqual(beforeDelivery.tables[table]);
  await mutationResult(info, 'source high-risk limitation', { secondApprover: id(1, 8), strongProofBlocked: true, deliveryMutation: false }, { secondApprover: row(after, 'requests', request).second_approved_by, strongProofBlocked: delivery.error?.message === 'strong_proof_required', deliveryMutation: false });
});

test('capability edits persist and the actual session provider removes an import action after reload', async ({ page }) => {
  await page.goto('/assets');
  await expect(page.locator('a[href="/assets/import"]')).toBeVisible();
  const registration = await rpc(page, 'list_registration_requests', { p_status: 'approved' });
  expect(registration.error).toBeNull();
  const registrationRows = registration.data as Row[];
  expect(registrationRows.find(item => item.id === id(1, 1))).toMatchObject({ assigned_role: 'it_manager' });
  // These are the canonical RPC's displayed fields, rather than raw app_users
  // columns. The real assignment dialog and account review consume this shape.
  for (const item of registrationRows) {
    for (const key of ['assigned_role', 'department_name', 'email_confirmed']) expect(Object.hasOwn(item, key)).toBe(true);
    expect(typeof item.email_confirmed).toBe('boolean');
  }
  const before = await snapshot(page);
  denied(await rpc(page, 'set_user_capability', { p_user: id(1, 4), p_key: 'asset.import', p_state: 'deny' }));
  denied(await rpc(page, 'set_role_capability', { p_role_key: 'viewer', p_key: 'asset.import', p_allowed: true }));
  expect((await snapshot(page)).tables.user_permissions).toEqual(before.tables.user_permissions);
  expect((await snapshot(page)).tables.role_permissions).toEqual(before.tables.role_permissions);
  await chooseRole(page, 'admin');
  denied(await rpc(page, 'set_user_capability', { p_user: id(1, 8), p_key: 'asset.import', p_state: 'deny' }));
  successful(await rpc(page, 'set_user_capability', { p_user: id(1, 1), p_key: 'asset.import', p_state: 'deny' }));
  await chooseRole(page, 'it_manager'); await page.goto('/assets'); await page.reload();
  const capabilities = await rpc(page, 'my_capabilities');
  expect(capabilities.error).toBeNull(); expect(capabilities.data).not.toContain('asset.import');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.locator('a[href="/assets/import"]')).toHaveCount(0);
  await chooseRole(page, 'admin');
  successful(await rpc(page, 'set_user_capability', { p_user: id(1, 1), p_key: 'asset.import', p_state: 'inherit' }));
  await chooseRole(page, 'it_manager'); await page.reload(); await page.goto('/assets'); await expect(page.locator('a[href="/assets/import"]')).toBeVisible();
});

test('portal attachment registration retry returns the same owned metadata once and foreign actor cannot register it', async ({ page }, info) => {
  await chooseRole(page, 'portal_requester');
  const created = await rpc(page, 'portal_create_request_atomic', { p_operation_id: crypto.randomUUID(), p_input: {
    project_name: 'DEMO QA attachment', project_city: 'Riyadh', contact_phone: '0500000100', contact_email: 'qa@demo.invalid',
    request_type: 'rental', pickup_date: portalPickup, return_date: portalReturn, notes: 'Attachment retry',
    items: [{ requested_kind: 'existing_asset', requested_description: 'Laptop', requested_category: 'Laptop', quantity: 1, preferred_model: null, accept_alternative: true, needs_purchase: false, category_key: 'laptop', preferred_company_id: id(2, 1), model_id: id(9, 1), consumable_id: null, additional_quantity_requested: false }],
  } }); successful(created);
  const requestId = (created.data as { id: string }).id;
  const path = `requests/${requestId}/portal/customer_visible/qa-retry.pdf`;
  const upload = await page.evaluate(async path => {
    const modulePath = '/src/demo/client.ts'; const client = await import(modulePath);
    const result = await client.createClient().storage.from('request-attachments').upload(path, new Blob(['Synthetic PDF fixture'], { type: 'application/pdf' }), { contentType: 'application/pdf', upsert: false });
    return { data: result.data, error: result.error ? { message: result.error.message } : null };
  }, path);
  expect(upload.error).toBeNull();
  const before = await snapshot(page), params = { p_request_id: requestId, p_file_name: 'qa-retry.pdf', p_storage_path: path };
  const first = await rpc(page, 'portal_register_request_attachment', params); successful(first);
  const committed = await snapshot(page);
  const retry = await rpc(page, 'portal_register_request_attachment', params); successful(retry);
  expect(retry.data).toMatchObject({ id: (first.data as { id: string }).id, registered: true });
  denied(await rpc(page, 'portal_register_request_attachment', { ...params, p_file_name: 'different.pdf' }));
  const after = await snapshot(page);
  expect(after.tables.request_attachments).toEqual(committed.tables.request_attachments);
  expect(after.tables.request_events).toEqual(committed.tables.request_events);
  expect(after.tables.request_attachments.length).toBe(before.tables.request_attachments.length + 1);
  expect(after.tables.request_events.filter(event => event.request_id === requestId && event.event_type === 'attachment_added')).toHaveLength(1);
  await chooseRole(page, 'portal_project_manager');
  denied(await rpc(page, 'portal_register_request_attachment', params));
  expect((await snapshot(page)).tables.request_attachments).toEqual(committed.tables.request_attachments);
  await chooseRole(page, 'it_manager');
  denied(await rpc(page, 'staff_set_request_attachment_visibility', { p_attachment_id: (first.data as { id: string }).id, p_visible: false }));
  expect((await snapshot(page)).tables.request_attachments).toEqual(committed.tables.request_attachments);
  const seededStaffAttachment = id(31, 1), seededRequest = id(16, 13);
  await chooseRole(page, 'warehouse_manager');
  const beforeVisibility = await snapshot(page);
  denied(await rpc(page, 'staff_set_request_attachment_visibility', { p_attachment_id: seededStaffAttachment, p_visible: false }));
  expect((await snapshot(page)).tables.request_attachments).toEqual(beforeVisibility.tables.request_attachments);
  expect((await snapshot(page)).tables.request_events).toEqual(beforeVisibility.tables.request_events);
  await chooseRole(page, 'it_manager');
  successful(await rpc(page, 'staff_set_request_attachment_visibility', { p_attachment_id: seededStaffAttachment, p_visible: false }));
  const hidden = await snapshot(page);
  expect(row(hidden, 'request_attachments', seededStaffAttachment)).toMatchObject({ visible_to_customer: false, classification: 'internal' });
  expect(hidden.tables.request_events.filter(event => event.request_id === seededRequest && event.event_type === 'attachment_visibility_changed')).toHaveLength(1);
  await chooseRole(page, 'portal_project_manager');
  const portalHidden = await rpc(page, 'portal_list_request_attachments', { p_request_id: seededRequest }); successful(portalHidden);
  expect((portalHidden.data as { attachments: Array<{ id: string }> }).attachments.map(attachment => attachment.id)).not.toContain(seededStaffAttachment);
  denied(await rpc(page, 'portal_get_request_attachment_path', { p_attachment_id: seededStaffAttachment }));
  await mutationResult(info, 'portal attachment lost-reply replay', { addedAttachments: 1, addedEvents: 1, retryId: (first.data as { id: string }).id, foreignActorDenied: true }, { addedAttachments: after.tables.request_attachments.length - before.tables.request_attachments.length, addedEvents: after.tables.request_events.filter(event => event.request_id === requestId && event.event_type === 'attachment_added').length, retry: retry.data });
});

test('reset invalidates a captured pending write and returns the complete baseline', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const modulePath = '/src/demo/data/index.ts';
    const data = await import(modulePath), store = data.getDemoStore();
    const before = await data.readDemoSnapshot(), context = store.capture();
    const clientPath = '/src/demo/client.ts'; const client = await import(clientPath);
    const uploadedKey = 'attachments/assets/0000000b-0000-4000-8000-000000000014/device_photo/qa-reset.pdf';
    const uploaded = await client.createClient().storage.from('attachments').upload(uploadedKey.slice('attachments/'.length), new Blob(['Synthetic reset-only PDF'], { type: 'application/pdf' }), { contentType: 'application/pdf', upsert: false });
    if (uploaded.error) throw new Error(`Reset fixture upload failed: ${uploaded.error.message}`);
    const uploadedPresent = Object.hasOwn((await data.readDemoSnapshot()).blobs, uploadedKey);
    await store.reset();
    let errorCode: string | null = null;
    try { await store.transact(context, (state: { tables: Record<string, Array<{ notes: string }>> }) => { state.tables.assets[0].notes = 'STALE QA WRITE'; return null; }); }
    catch (error) { errorCode = error instanceof Error && 'code' in error ? String(error.code) : 'unknown'; }
    const after = await data.readDemoSnapshot();
    return { errorCode, beforeGeneration: before.generation, afterGeneration: after.generation, stalePresent: after.tables.assets.some((asset: { notes: string }) => asset.notes === 'STALE QA WRITE'), operations: Object.keys(after.operations).length, actorId: after.actorId, beforeBlobKeys: Object.keys(before.blobs).sort(), afterBlobKeys: Object.keys(after.blobs).sort(), uploadedPresent, uploadedAfterReset: Object.hasOwn(after.blobs, uploadedKey) };
  });
  expect(result.errorCode).toBe('DEMO_STALE_OPERATION');
  expect(result.afterGeneration).toBeGreaterThan(result.beforeGeneration);
  expect(result.stalePresent).toBe(false);
  expect(result.operations).toBe(0);
  expect(result.actorId).toBeNull(); expect(result.uploadedPresent).toBe(true); expect(result.uploadedAfterReset).toBe(false);
  expect(result.afterBlobKeys).toEqual(result.beforeBlobKeys);
});

test('separate browser profiles isolate mutations and reset; same-profile tabs share committed state', async ({ page, browser, baseURL }) => {
  if (!baseURL) throw new Error('baseURL required');
  const other = await browser.newContext({ baseURL, serviceWorkers: 'block' });
  const violations = await auditContext(other, new URL(baseURL).origin);
  try {
    const second = await other.newPage(); await chooseRole(second, 'it_manager');
    const aBefore = await snapshot(page), bBefore = await snapshot(second), target = id(14, 3);
    expect(row(aBefore, 'consumables', target).quantity_on_hand).toBe(row(bBefore, 'consumables', target).quantity_on_hand);
    successful(await rpc(page, 'consumable_stock_move_idempotent', { p_consumable_id: target, p_type: 'out', p_quantity: 1, p_reason: 'Profile A', p_operation_id: crypto.randomUUID() }));
    const aChanged = await snapshot(page);
    expect(row(await snapshot(second), 'consumables', target).quantity_on_hand).toBe(row(bBefore, 'consumables', target).quantity_on_hand);
    const sibling = await page.context().newPage(); await sibling.goto('/assets');
    expect(row(await snapshot(sibling), 'consumables', target).quantity_on_hand).toBe(row(aChanged, 'consumables', target).quantity_on_hand);
    await second.evaluate(async () => { const modulePath = '/src/demo/data/index.ts'; const data = await import(modulePath); await data.getDemoStore().reset(); });
    expect(row(await snapshot(page), 'consumables', target).quantity_on_hand).toBe(row(aChanged, 'consumables', target).quantity_on_hand);
    expect(violations).toEqual([]);
    await sibling.close();
  } finally { await other.close(); }
});
