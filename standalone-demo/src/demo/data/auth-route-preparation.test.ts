import { describe, expect, it, vi } from 'vitest';
import { prepareDemoAuthRoute, type DemoPreparedAuthPath } from './auth';
import { createDemoStore, type DemoStore } from './store';
import { demoId } from './seed';
const prepare = (path: DemoPreparedAuthPath, expectedActorId: string | null, isCurrent: () => boolean, store: DemoStore) => prepareDemoAuthRoute(path, expectedActorId, store.getGeneration(), isCurrent, store);

describe('atomic local auth route preparation', () => {
  it('prepares an anonymous pending actor and overlay together with one notification, without changing real profiles', async () => {
    const store = createDemoStore({ memory: true });
    const before = await store.read();
    const observed: Array<{ actorId: string | null; generation: number }> = [];
    const notify = vi.fn(() => observed.push({ actorId: store.getActor()?.id ?? null, generation: store.getGeneration() }));
    store.subscribe(notify);
    expect(await prepare('/pending-approval', null, () => true, store)).toEqual({ prepared: true, actorId: 'employee' });
    const prepared = await store.read();
    expect(prepared).toMatchObject({ actorId: 'employee', authScenario: { actorId: 'employee', status: 'pending' }, generation: before.generation + 1, revision: before.revision + 1 });
    expect(prepared.tables.app_users).toEqual(before.tables.app_users);
    expect(prepared.tables.role_permissions).toEqual(before.tables.role_permissions);
    expect(prepared.tables.user_permissions).toEqual(before.tables.user_permissions);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(observed).toEqual([{ actorId: 'employee', generation: before.generation + 1 }]);
    expect(await prepare('/pending-approval', 'employee', () => true, store)).toEqual({ prepared: true, actorId: 'employee' });
    expect(await store.read()).toEqual(prepared);
    expect(notify).toHaveBeenCalledTimes(1);
    store.close();
  });

  it('aborts a replaced effect before any write while its current replacement completes once', async () => {
    const store = createDemoStore({ memory: true });
    const before = await store.read();
    let oldCurrent = true;
    const oldEffect = prepare('/pending-approval', null, () => oldCurrent, store);
    oldCurrent = false;
    const currentEffect = prepare('/pending-approval', null, () => true, store);
    expect(await oldEffect).toEqual({ prepared: false, actorId: null });
    expect(await currentEffect).toEqual({ prepared: true, actorId: 'employee' });
    expect((await store.read()).generation).toBe(before.generation + 1);
    store.close();
  });

  it('cancels under the transaction lock without changing even the revision', async () => {
    const store = createDemoStore({ memory: true });
    const before = await store.read();
    const notify = vi.fn(); store.subscribe(notify);
    let checks = 0;
    expect(await prepare('/pending-approval', null, () => ++checks === 1, store)).toEqual({ prepared: false, actorId: null });
    expect(checks).toBe(2);
    expect(await store.read()).toEqual(before);
    expect(notify).not.toHaveBeenCalled();
    store.close();
  });

  it('rejects queued preparation after a real role switch or dataset reset, without resurrecting its actor', async () => {
    for (const change of ['role', 'reset'] as const) {
      const store = createDemoStore({ memory: true });
      await store.setActor('it_manager');
      const changing = change === 'role' ? store.setActor('viewer') : store.reset();
      const stale = prepare('/pending-approval', 'it_manager', () => true, store);
      await changing;
      const afterChange = await store.read();
      await expect(stale).rejects.toMatchObject({ code: 'DEMO_STALE_OPERATION' });
      expect(await store.read()).toEqual(afterChange);
      expect(afterChange.actorId).toBe(change === 'role' ? 'viewer' : null);
      expect(afterChange.authScenario).toBeUndefined();
      store.close();
    }
  });

  it('keeps account and capability changes authoritative while a preparation is queued', async () => {
    for (const change of ['account', 'capability'] as const) {
      const store = createDemoStore({ memory: true });
      await store.setActor('it_manager');
      const permission = store.getActor()!.capabilities[0];
      const changing = store.transact(store.capture(), state => {
        if (change === 'account') state.tables.app_users.find(user => user.id === demoId(1, 1))!.is_active = false;
        else state.tables.user_permissions.push({ user_id: demoId(1, 1), permission_key: permission, allow: false });
      });
      const stale = prepare('/pending-approval', 'it_manager', () => true, store);
      await changing;
      const changed = await store.read();
      await expect(stale).rejects.toMatchObject({ code: 'DEMO_STALE_OPERATION' });
      expect(await store.read()).toEqual(changed);
      expect(changed.authScenario).toBeUndefined();
      store.close();
    }
  });

  it('prepares anonymous MFA or registration atomically and retains an existing staff identity', async () => {
    const store = createDemoStore({ memory: true });
    const before = await store.read();
    expect(await prepare('/auth/mfa', null, () => true, store)).toEqual({ prepared: true, actorId: 'admin' });
    expect((await store.read()).authScenario).toBeUndefined();
    await store.setActor('it_manager');
    expect(await prepare('/pending-approval', 'it_manager', () => true, store)).toEqual({ prepared: true, actorId: 'it_manager' });
    expect(await prepare('/auth/mfa', 'it_manager', () => true, store)).toEqual({ prepared: true, actorId: 'it_manager' });
    expect((await store.read()).authScenario).toBeUndefined();
    expect(await prepare('/client-portal-register', 'it_manager', () => true, store)).toEqual({ prepared: true, actorId: null });
    const registered = await store.read();
    expect(registered.authScenario).toBeUndefined();
    expect(registered.tables.app_users).toEqual(before.tables.app_users);
    expect(registered.tables.role_permissions).toEqual(before.tables.role_permissions);
    expect(registered.tables.user_permissions).toEqual(before.tables.user_permissions);
    store.close();
  });

  it('rejects a prior anonymous generation after reset even when the actor id is still null', async () => {
    const store = createDemoStore({ memory: true });
    const generation = store.getGeneration();
    await store.reset();
    const reset = await store.read();
    await expect(prepareDemoAuthRoute('/pending-approval', null, generation, () => true, store)).rejects.toMatchObject({ code: 'DEMO_STALE_OPERATION' });
    expect(await store.read()).toEqual(reset);
    store.close();
  });
});
