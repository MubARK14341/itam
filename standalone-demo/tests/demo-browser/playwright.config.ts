import { defineConfig } from '@playwright/test';

const baseURL = process.env.DEMO_BASE_URL ?? 'http://127.0.0.1:4173';
const target = new URL(baseURL);
const runId = process.env.DEMO_QA_RUN_ID ?? 'latest';
if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(runId)) throw new Error('DEMO_QA_RUN_ID must be a simple artifact label.');
if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(target.hostname) || !['4173', '4174'].includes(target.port) || target.pathname !== '/' || target.username || target.password || target.search || target.hash) {
  throw new Error('Local Demo QA permits only the owned loopback servers on ports 4173/4174. Use the separate exact-target published config for the authorized Demo site.');
}

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 12_000 },
  outputDir: `../../artifacts/demo-browser/${runId}/results`,
  reporter: [['list'], ['json', { outputFile: `../../artifacts/demo-browser/${runId}/results.json` }]],
  use: { baseURL: target.origin, browserName: 'chromium', headless: true, actionTimeout: 15_000, serviceWorkers: 'block', screenshot: 'only-on-failure', trace: 'off', video: 'off' },
  // The parent owns the server and the published target. Tests do not start,
  // download, build or reuse another application server implicitly.
});
