import {createHash} from 'node:crypto';
import {existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {dirname, resolve, relative} from 'node:path';

export function assertArtifactRuntime(env, url) {
  if (env.VERCEL_ENV || env.VERCEL_PROJECT_ID || url !== 'https://demo.invalid') {
    throw new Error('Hosted release is disabled; publication artifact target mismatch.');
  }
}

export function renderReleaseConfig(source, release) {
  const guard = 'assertApprovedOrLocalSupabaseTarget({\n  url: runtimeSupabaseUrl,\n  projectRef: runtimeProjectRef,\n});';
  if (!source.includes(guard)) throw new Error('Source config changed; review the local artifact adapter again.');
  if (!release || !/^[a-z0-9-]+$/.test(release.id) || release.supabaseOrigin !== 'https://demo.invalid'
    || !release.officialHost.endsWith('.example.invalid')) throw new Error('Only a synthetic offline review artifact is supported.');
  // Keep the application boundary; add a second fail-closed runtime assertion.
  return source.replace(guard, `${guard}\n/* publication-runtime:start */\n${assertArtifactRuntime.toString()}\nassertArtifactRuntime(process.env, runtimeSupabaseUrl);\n/* publication-runtime:end */\n// Local review package: ${release.id}`);
}

export function prepareRelease(sourceRoot, destination, release) {
  if (existsSync(destination)) throw new Error('Release destination already exists; immutable package required.');
  const source = readFileSync(resolve(sourceRoot,'next.config.mjs'),'utf8');
  const config = renderReleaseConfig(source,release); // Validate before creating output.
  const selected = ['src','public','package.json','package-lock.json','next-env.d.ts','tsconfig.json',
    'tailwind.config.ts','postcss.config.mjs','.eslintrc.json','scripts/safety/production-boundary.mjs'];
  const files = new Map();
  function collect(path) {
    const rel = relative(sourceRoot,path);
    if (lstatSync(path).isSymbolicLink()) throw new Error('Symlinks are forbidden in a review artifact.');
    if (rel.split(/[\\/]/).some(part=>['.git','.next','node_modules','.vercel','.netlify'].includes(part)||part.startsWith('.env'))
      || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(rel)) return;
    if (lstatSync(path).isDirectory()) for(const name of readdirSync(path)) collect(resolve(path,name));
    else files.set(rel,readFileSync(path));
  }
  for(const rel of selected) {
    const path=resolve(sourceRoot,rel);
    if (!existsSync(path)) throw new Error(`Required local review source missing: ${rel}`);
    collect(path);
  }
  files.set('next.config.mjs',Buffer.from(config));
  mkdirSync(destination,{recursive:true});
  const hashes={};
  for(const [rel,bytes] of files){
    const path=resolve(destination,'itam-app',rel);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,bytes);
    hashes['itam-app/'+rel]=createHash('sha256').update(bytes).digest('hex');
  }
  const manifest={release,mode:'offline_review_only',deployable:false,files:hashes};
  writeFileSync(resolve(destination,'release-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  return manifest;
}
