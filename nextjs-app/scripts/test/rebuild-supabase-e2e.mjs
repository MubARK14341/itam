import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const ROOT=resolve(import.meta.dirname,'../..');
// Planning does not start Supabase, reset a DB, or invoke Docker.
if(process.argv.slice(2).join(' ')!=='--plan')throw Error('Database execution is disabled; use --plan for local source verification.');
const check=spawnSync(process.execPath,['scripts/audit/generate-migration-manifest.mjs'],{cwd:ROOT,encoding:'utf8'});
if(check.status!==0)throw Error('Migration manifest verification failed before local reset');
const manifest=JSON.parse(readFileSync(resolve(ROOT,'docs/audit-remediation/MIGRATION_MANIFEST.json'),'utf8'));
console.log(JSON.stringify({mode:'plan_only',executed:false,steps:manifest.ordered.map(s=>s.path),excluded:manifest.productionOnly.map(s=>s.path)}));
