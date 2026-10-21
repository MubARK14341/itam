import {assertPublicationEnvironment, assertApprovedOrLocalSupabaseTarget} from './scripts/safety/production-boundary.mjs';
assertPublicationEnvironment(process.env);
const runtimeSupabaseUrl = 'https://demo.invalid';
const runtimeProjectRef = 'demo';
assertApprovedOrLocalSupabaseTarget({
  url: runtimeSupabaseUrl,
  projectRef: runtimeProjectRef,
});
/** @type {import('next').NextConfig} */
export default {
 poweredByHeader:false,
 env:{NEXT_PUBLIC_SUPABASE_URL:'https://demo.invalid',NEXT_PUBLIC_SUPABASE_ANON_KEY:'demo-placeholder'},
 async headers(){return [{source:'/:path*',headers:[{key:'X-Content-Type-Options',value:'nosniff'},{key:'Content-Security-Policy',value:"default-src 'self'; object-src 'none'; connect-src 'self'; img-src 'self' data: blob:; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; frame-src 'none'; form-action 'self'; base-uri 'self'"}]}]}
};
