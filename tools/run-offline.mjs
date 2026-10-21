import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const commands={
  "demo": [
    "standalone-demo",
    "vite",
    "--host",
    "127.0.0.1"
  ],
  "demo:build": [
    "standalone-demo",
    "vite",
    "build"
  ],
  "demo:typecheck": [
    "standalone-demo",
    "tsc",
    "--noEmit"
  ],
  "demo:test": [
    "standalone-demo",
    "vitest",
    "run"
  ],
  "core:lint": [
    "nextjs-app",
    "next",
    "lint"
  ],
  "core:typecheck": [
    "nextjs-app",
    "tsc",
    "--noEmit"
  ],
  "core:test": [
    "nextjs-app",
    "vitest",
    "run"
  ],
  "core:build": [
    "nextjs-app",
    "next",
    "build"
  ]
};
const key=process.argv[2];
if (!commands[key]) throw Error('Unknown reviewed offline command');
const [cwd, binary, ...args]=commands[key];
const location=path.join(root,cwd);
const env={PATH:process.env.PATH, TMPDIR:process.env.TMPDIR, LANG:'en_US.UTF-8', CI:'1', NEXT_TELEMETRY_DISABLED:'1', EXPO_NO_TELEMETRY:'1', EXPO_OFFLINE:'1', NODE_OPTIONS:`--require=${path.join(root,'tools/offline-guard.cjs')}`, NEXT_PUBLIC_SUPABASE_URL:'https://demo.invalid', NEXT_PUBLIC_SUPABASE_ANON_KEY:'demo-placeholder', NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:'demo-placeholder', EXPO_PUBLIC_SUPABASE_URL:'https://demo.invalid', EXPO_PUBLIC_SUPABASE_ANON_KEY:'demo-placeholder'};
const executable=path.join(location,'node_modules/.bin',binary);
const result=spawnSync(executable,args,{cwd:location,env,stdio:'inherit'});
if(result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
