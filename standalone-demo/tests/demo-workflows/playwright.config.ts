import { defineConfig } from '@playwright/test';
import surface from '../demo-browser/playwright.config';

const runId = process.env.DEMO_QA_RUN_ID ?? 'latest';
if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(runId)) throw new Error('DEMO_QA_RUN_ID must be a simple artifact label.');

export default defineConfig({
  ...surface, testDir: '.', timeout: 120_000,
  use: { ...surface.use, actionTimeout: 15_000 },
  outputDir: `../../artifacts/demo-workflows/${runId}/results`,
  reporter: [['list'], ['json', { outputFile: `../../artifacts/demo-workflows/${runId}/results.json` }]],
});
