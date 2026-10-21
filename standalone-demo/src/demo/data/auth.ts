import type { Session, User } from "@supabase/supabase-js";
import { DEMO_PERSONAS } from "./seed";
import { getDemoStore, assertDemoAuthorizationContext, type DemoStore } from "./store";
import { type DemoActor,type DemoState,type OperationContext,type Row,DemoError,object,str,rows,uid,now,requireActor } from "./types";
import { registerDemoIdentity } from "./registration";
export const DEMO_SUPABASE_URL="https://demo.invalid";
export const DEMO_SUPABASE_ANON_KEY="demo-local-placeholder-no-network";
const b64=(value:unknown)=>{
  const bytes=new TextEncoder().encode(JSON.stringify(value));
  return btoa(Array.from(bytes,byte=>String.fromCharCode(byte)).join(""))
    .replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");
};
function decodeDemoClaims(value:string):Row{
  if(!/^([a-z0-9_-]{4})*($|[a-z0-9_-]{3}$|[a-z0-9_-]{2}$)$/i.test(value))throw new Error("Invalid local session encoding");
  const encoded=value.replace(/-/g,"+").replace(/_/g,"/");
  const binary=atob(encoded.padEnd(Math.ceil(encoded.length/4)*4,"="));
  return object(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(Uint8Array.from(binary,char=>char.charCodeAt(0)))));
}
export function demoSession(actor:DemoActor|null,generation:number):Session|null{if(!actor)return null;const user:User={id:actor.userId,aud:"authenticated",role:"authenticated",email:actor.email,email_confirmed_at:"2026-01-01T00:00:00.000Z",created_at:"2026-01-01T00:00:00.000Z",app_metadata:{provider:"demo",providers:["demo"]},user_metadata:{full_name:actor.nameAr,user_type:actor.portalRole?"portal":"staff"}};const token=`${b64({alg:"none",typ:"JWT"})}.${b64({sub:actor.userId,demoPersona:actor.id,generation,role:"authenticated",aud:"authenticated",exp:Math.floor(Date.now()/1000)+3600})}.demo-local`;return{access_token:token,refresh_token:"demo-refresh-local",token_type:"bearer",expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,user};}
export function getDemoSession():Session|null{const store=getDemoStore(),session=demoSession(store.getActor(),store.getGeneration());if(!session)return null;session.user.factors=store.getMfaFactors().map(f=>({id:str(f.id),friendly_name:str(f.friendly_name),factor_type:"totp",status:f.status==="verified"?"verified":"unverified",created_at:str(f.created_at),updated_at:str(f.updated_at)}));return session;}
export async function setDemoActor(personaId:string|null):Promise<void>{await getDemoStore().setActor(personaId);}
export type DemoPreparedAuthPath = "/register" | "/client-portal-register" | "/pending-approval" | "/auth/mfa";
export function prepareDemoAuthRoute(path: DemoPreparedAuthPath, expectedActorId: string | null, expectedGeneration: number, isCurrent: () => boolean, store: DemoStore = getDemoStore()) {
  const mode = path === "/pending-approval" ? "pending" : path === "/auth/mfa" ? "mfa" : "registration";
  return store.prepareAuthRoute(mode, expectedActorId, expectedGeneration, isCurrent);
}
export async function setDemoAuthScenario(scenario:"pending"|"rejected"|"approved"|null,store:DemoStore=getDemoStore()):Promise<void>{
  await store.ready;
  if(scenario!==null&&!store.getActor())await store.setActor("employee");
  const snapshot=await store.read(),actor=store.getActor();
  if(scenario===null&&!snapshot.authScenario)return;
  if(scenario!==null&&snapshot.authScenario&&snapshot.authScenario.actorId===actor?.id&&snapshot.authScenario.status===scenario)return;
  await store.transact(store.capture(),s=>{if(scenario===null)delete s.authScenario;else if(actor)s.authScenario={actorId:actor.id,status:scenario};s.generation++;});
}
// Apply only to a detached request snapshot. Real approval/active edits remain
// authoritative; a walkthrough can never reactivate a rejected/disabled user.
export function applyDemoAuthScenario(s:DemoState):DemoState {
  const scenario=s.authScenario;
  if(!scenario||scenario.actorId!==s.actorId)return s;
  const persona=DEMO_PERSONAS.find(a=>a.id===scenario.actorId);
  const user=rows(s,"app_users").find(u=>u.id===persona?.userId);
  if(user?.approval_status==="approved"&&user.is_active===true)Object.assign(user,{approval_status:scenario.status,is_active:scenario.status==="approved",rejection_reason:scenario.status==="rejected"?"محاكاة رفض تجريبي":null});
  return s;
}
export function checkDemoAuthorization(header:string|null,ctx:OperationContext):void{if(!header||header===`Bearer ${DEMO_SUPABASE_ANON_KEY}`)return;const token=header.replace(/^Bearer /i,"");try{const segments=token.split(".");if(segments.length!==3||segments[2]!=="demo-local")throw new Error();const claims=decodeDemoClaims(segments[1]);if(claims.sub!==ctx.actor?.userId||claims.generation!==ctx.generation)throw new DemoError("DEMO_STALE_OPERATION","operation_actor_changed",409);}catch(error){if(error instanceof DemoError)throw error;throw new DemoError("42501","invalid_demo_session",401);}}
export async function handleDemoAuth(store:DemoStore,ctx:OperationContext,path:string,method:string,p:Row):Promise<unknown>{
  const methods:Record<string,string[]>={"/auth/v1/user":["GET","PUT"],"/auth/v1/token":["POST"],"/auth/v1/logout":["POST"],"/auth/v1/recover":["POST"],"/auth/v1/resend":["POST"],"/auth/v1/otp":["POST"],"/auth/v1/signup":["POST"],"/auth/v1/factors":["GET","POST"]};const allowed=methods[path]??(/^\/auth\/v1\/factors\/[a-f0-9-]+\/(challenge|verify)$/.test(path)?["POST"]:/^\/auth\/v1\/factors\/[a-f0-9-]+$/.test(path)?["DELETE"]:[]);if(!allowed.includes(method))throw new DemoError("DEMO_UNSUPPORTED_OPERATION","Unsupported demo auth method",405);
  const snapshot=await store.read();assertDemoAuthorizationContext(snapshot,ctx);
  if(path==="/auth/v1/user"){const actor=requireActor(ctx);if(method==="PUT"){await store.transact(ctx,s=>{const profile=rows(s,"app_users").find(u=>u.id===actor.userId);if(profile&&p.data)profile.full_name=object(p.data).full_name??profile.full_name;});}return{...demoSession(actor,ctx.generation)!.user,factors:snapshot.mfa[actor.userId]??[]};}
  if(path==="/auth/v1/token"){const actor=DEMO_PERSONAS.find(a=>a.email===p.email)||ctx.actor;if(!actor)throw new DemoError("invalid_credentials","Choose a demo persona to sign in",400);await store.setActor(actor.id,ctx);return demoSession(store.getActor(),store.getGeneration());}
  if(path==="/auth/v1/logout"){await store.setActor(null,ctx);return{};}
  if(path==="/auth/v1/recover"||path==="/auth/v1/resend"||path==="/auth/v1/otp")return{simulated:true,message:"Demo only: no email or SMS was sent."};
  if(path==="/auth/v1/signup"){if(!str(p.email).includes("@")||str(p.password).length<6)throw new DemoError("validation_failed","Enter a valid email and at least six password characters");const userId=uid();const metadata=p.data&&typeof p.data==="object"?object(p.data):{};await store.transact(ctx,s=>registerDemoIdentity(s,userId,str(p.email),metadata));return{id:userId,aud:"authenticated",email:p.email,app_metadata:{provider:"demo"},user_metadata:metadata,created_at:now(),identities:[]};}
  if(path==="/auth/v1/factors"&&method==="GET"){const actor=requireActor(ctx);return{factors:snapshot.mfa[actor.userId]??[]};}
  if(path==="/auth/v1/factors"&&method==="POST"){const actor=requireActor(ctx);const factor={id:uid(),friendly_name:p.friendly_name??"Demo MFA",factor_type:"totp",status:"unverified",created_at:now(),updated_at:now()};await store.transact(ctx,s=>{(s.mfa[actor.userId]??=[]).push(factor);});return{...factor,type:"totp",totp:{qr_code:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="white"/><text x="8" y="50" font-size="14">DEMO 123456</text></svg>',secret:"DEMO-LOCAL-OTP-123456",uri:"otpauth://totp/LocalDemo?secret=DEMOONLY"}};}
  const match=path.match(/^\/auth\/v1\/factors\/([a-f0-9-]+)(?:\/(challenge|verify))?$/);
  if(match){const actor=requireActor(ctx);if(!(snapshot.mfa[actor.userId]??[]).some(f=>f.id===match[1]))throw new DemoError("factor_not_found","MFA factor not found",404);if(method==="DELETE"){await store.transact(ctx,s=>{s.mfa[actor.userId]=(s.mfa[actor.userId]??[]).filter(f=>f.id!==match[1]);});return{};}if(match[2]==="challenge")return{id:uid(),expires_at:Math.floor(Date.now()/1000)+300,type:"totp"};if(match[2]==="verify"){if(p.code!=="123456")throw new DemoError("mfa_verification_failed","Demo verification code is 123456");await store.transact(ctx,s=>{const factor=(s.mfa[actor.userId]??[]).find(f=>f.id===match[1]);if(!factor)throw new DemoError("factor_not_found","MFA factor not found",404);factor.status="verified";});return demoSession(actor,store.getGeneration());}}
  throw new DemoError("DEMO_UNSUPPORTED_OPERATION",`Unsupported demo auth operation: ${method} ${path}`,404);
}
