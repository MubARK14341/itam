import { createSeed, DEMO_PERSONAS } from "./seed";
import { DemoError, stableJson, type DemoActor, type DemoState, type OperationContext } from "./types";
export type DemoStoreOptions = { memory?: boolean; databaseName?: string };
export type DemoAuthRouteMode = "registration" | "pending" | "mfa";
export type DemoAuthRoutePreparation = { prepared: boolean; actorId: string | null };
// A cancelled or already prepared intent aborts the transaction before any
// revision/generation write. Stale identity/authorization errors still reject.
class UnchangedAuthRoutePreparation extends Error {
  constructor(readonly result: DemoAuthRoutePreparation) { super("Unchanged local auth route preparation"); }
}
export class DemoStore {
  readonly ready: Promise<void>;
  private db: IDBDatabase | null = null;
  private state = createSeed();
  private listeners = new Set<() => void>();
  private channel: BroadcastChannel | null = null;
  private serial: Promise<unknown> = Promise.resolve();
  private memory: boolean;
  constructor(options: DemoStoreOptions = {}) {
    this.memory = options.memory === true;
    this.ready = this.memory ? Promise.resolve() : this.open(options.databaseName ?? "itam-manager-demo-v1");
    if (!this.memory && typeof BroadcastChannel !== "undefined") {
      this.channel = new BroadcastChannel("itam-manager-demo-v1");
      this.channel.onmessage = () => { void this.read().then(() => this.notify(false)).catch(() => undefined); };
    }
  }
  private async open(name: string): Promise<void> {
    if (typeof indexedDB === "undefined") throw new DemoError("DEMO_STORAGE_UNAVAILABLE", "This demo requires browser IndexedDB. Enable local storage to continue.", 503);
    this.db = await new Promise<IDBDatabase>((resolve,reject) => { const req=indexedDB.open(name,1);req.onupgradeneeded=()=>req.result.createObjectStore("local-state");req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(new DemoError("DEMO_STORAGE_UNAVAILABLE","Unable to open local demo storage",503)); });
    await this.transaction(state => state, null, true);
  }
  getActor(): DemoActor | null { return actorForState(this.state); }
  getMfaFactors(): Record<string, unknown>[] { const actor=this.getActor();return actor?structuredClone(this.state.mfa[actor.userId]??[]):[]; }
  getGeneration(): number { return this.state.generation; }
  capture(): OperationContext { return { actor: this.getActor(), generation:this.state.generation, revision:this.state.revision,authorizationFingerprint:authorizationFingerprint(this.state) }; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private notify(broadcast=true): void { for(const listener of this.listeners) { try {listener();} catch { /* Subscribers cannot invalidate a committed local transaction. */ } } if(broadcast)this.channel?.postMessage({generation:this.state.generation,revision:this.state.revision}); }
  async read(): Promise<DemoState> {
    await this.ready;
    if(this.memory)return structuredClone(this.state);
    const data=await new Promise<DemoState>((resolve,reject)=>{const tx=this.db!.transaction("local-state","readonly");const req=tx.objectStore("local-state").get("state");req.onsuccess=()=>resolve(req.result as DemoState);req.onerror=()=>reject(new DemoError("DEMO_STORAGE_UNAVAILABLE","Unable to read demo state",503));});
    this.state=data;return structuredClone(data);
  }
  async transact<T>(ctx: OperationContext, work:(state:DemoState)=>T):Promise<T>{await this.ready;const result=await this.transaction(work,ctx);this.notify();return result;}
  private transaction<T>(work:(state:DemoState)=>T,ctx:OperationContext|null,initialize=false):Promise<T>{
    const verify=(state:DemoState)=>{if(ctx&&(state.generation!==ctx.generation||state.actorId!==(ctx.actor?.id??null)))throw new DemoError("DEMO_STALE_OPERATION","The demo identity or dataset changed. Reload the current view before retrying.",409);if(ctx)assertDemoAuthorizationContext(state,ctx);};
    if(this.memory){const task=this.serial.then(()=>{const next=structuredClone(this.state);verify(next);const result=work(next);if(result&&typeof result==="object"&&"then" in result)throw new DemoError("DEMO_ASYNC_TRANSACTION","Demo mutations must be synchronous",400);const returned=structuredClone(result);next.revision++;this.state=next;return returned;});this.serial=task.catch(()=>undefined);return task;}
    return new Promise<T>((resolve,reject)=>{const tx=this.db!.transaction("local-state","readwrite");const objectStore=tx.objectStore("local-state");const req=objectStore.get("state");let result:T;let staged:DemoState;let failure:unknown;req.onsuccess=()=>{try{const existing=req.result as DemoState|undefined;const next=existing??createSeed();verify(next);const produced=work(next);if(produced&&typeof produced==="object"&&"then" in produced)throw new DemoError("DEMO_ASYNC_TRANSACTION","Demo mutations must be synchronous",400);result=structuredClone(produced);if(!initialize||!existing){next.revision++;objectStore.put(next,"state");}staged=next;}catch(error){failure=error;tx.abort();}};tx.oncomplete=()=>{this.state=staged;resolve(result);};tx.onabort=()=>reject(failure??new DemoError("DEMO_STORAGE_UNAVAILABLE","Demo transaction aborted",503));tx.onerror=()=>{failure??=new DemoError("DEMO_STORAGE_UNAVAILABLE","Demo transaction failed",503);};});
  }
  async setActor(personaId:string|null,ctx?:OperationContext):Promise<void>{await this.ready;if(personaId!==null&&!DEMO_PERSONAS.some(p=>p.id===personaId))throw new DemoError("22023","Unknown demo persona");await this.transaction(state=>{state.actorId=personaId;delete state.authScenario;state.generation++;return null;},ctx??null);this.notify();}
  async prepareAuthRoute(mode: DemoAuthRouteMode, expectedActorId: string | null, expectedGeneration: number, isCurrent: () => boolean): Promise<DemoAuthRoutePreparation> {
    await this.ready;
    if (!isCurrent()) return { prepared: false, actorId: this.getActor()?.id ?? null };
    const context = this.capture();
    if ((context.actor?.id ?? null) !== expectedActorId || context.generation !== expectedGeneration) throw new DemoError("DEMO_STALE_OPERATION", "The demo identity or dataset changed before route preparation", 409);
    try {
      const result = await this.transaction(state => {
        if (!isCurrent()) throw new UnchangedAuthRoutePreparation({ prepared: false, actorId: state.actorId });
        const staffActorId = context.actor && !context.actor.portalRole ? context.actor.id : mode === "pending" ? "employee" : "admin";
        const actorId = mode === "registration" ? null : staffActorId;
        const scenario = mode === "pending" ? { actorId: staffActorId, status: "pending" as const } : undefined;
        if (state.actorId === actorId && stableJson(state.authScenario ?? null) === stableJson(scenario ?? null)) throw new UnchangedAuthRoutePreparation({ prepared: true, actorId });
        state.actorId = actorId;
        if (scenario) state.authScenario = scenario; else delete state.authScenario;
        state.generation++;
        return { prepared: true, actorId };
      }, context);
      this.notify();
      return result;
    } catch (error) {
      if (error instanceof UnchangedAuthRoutePreparation) return error.result;
      throw error;
    }
  }
  async reset():Promise<void>{await this.ready;await this.transaction(state=>{const fresh=createSeed(state.generation+1,null);Object.assign(state,fresh);delete state.authScenario;return null;},null);this.notify();}
  close():void{this.channel?.close();this.db?.close();this.listeners.clear();}
}
let singleton:DemoStore|undefined;
export function getDemoStore():DemoStore{return singleton??=new DemoStore();}
export function createDemoStore(options:DemoStoreOptions={}):DemoStore{return new DemoStore(options);}
function strField(value:unknown,fallback:string):string{return typeof value==="string"?value:fallback;}

function actorForState(state:DemoState):DemoActor|null {
  const persona=DEMO_PERSONAS.find(p=>p.id===state.actorId);if(!persona)return null;
  if(persona.portalRole){const user=state.tables.customer_portal_users.find(u=>u.id===persona.userId);return{...persona,portalRole:user?.portal_role as DemoActor["portalRole"]??persona.portalRole,customerId:strField(user?.customer_id,persona.customerId??""),name:strField(user?.contact_name,persona.name),nameAr:strField(user?.contact_name,persona.nameAr)};}
  const profile=state.tables.app_users.find(u=>u.id===persona.userId),role=profile?.role_key as DemoActor["role"]??persona.role;
  const capabilities=new Set(state.tables.role_permissions.filter(r=>r.role_key===role&&r.allowed!==false).map(r=>strField(r.permission_key??r.key,"")));
  for(const override of state.tables.user_permissions.filter(r=>r.user_id===persona.userId)){const key=strField(override.permission_key??override.key,"");if(override.allow)capabilities.add(key);else capabilities.delete(key);}
  return{...persona,role,employeeId:typeof profile?.employee_id==="string"?profile.employee_id:undefined,name:strField(profile?.full_name,persona.name),nameAr:strField(profile?.full_name,persona.nameAr),capabilities:[...capabilities]};
}
// Authorization can change without a dataset reset. This comparison happens
// inside the IDB transaction, while its write lock still protects the state.
// Stock, operation ledgers and other ordinary revisions are deliberately absent.
function authorizationFingerprint(state:DemoState):string {
  const actor=actorForState(state);if(!actor)return "anonymous";
  const identity={id:actor.id,userId:actor.userId,role:actor.role,portalRole:actor.portalRole??null,employeeId:actor.employeeId??null,customerId:actor.customerId??null,capabilities:[...actor.capabilities].sort()};
  if(actor.portalRole){const user=state.tables.customer_portal_users.find(u=>u.id===actor.userId),customer=state.tables.customers.find(c=>c.id===actor.customerId),settings=state.tables.customer_portal_settings.find(c=>c.customer_id===actor.customerId);return stableJson({identity,active:user?.is_active??false,customerActive:customer?.is_active??false,approval:customer?.approval_status??null,settings});}
  const user=state.tables.app_users.find(u=>u.id===actor.userId);
  return stableJson({identity,active:user?.is_active??false,approval:user?.approval_status??null,scenario:state.authScenario??null});
}

export function assertDemoAuthorizationContext(state:DemoState,ctx:OperationContext):void {
  if(state.generation!==ctx.generation||state.actorId!==(ctx.actor?.id??null))throw new DemoError("DEMO_STALE_OPERATION","The demo identity or dataset changed. Reload the current view before retrying.",409);
  if(ctx.authorizationFingerprint!==authorizationFingerprint(state))throw new DemoError("DEMO_STALE_OPERATION","The demo authorization changed. Reload the current view before retrying.",409);
}
