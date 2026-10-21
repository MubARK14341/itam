import {defineConfig} from '@playwright/test';
import {assertLoopbackBaseUrl} from './scripts/test/loopback-target.mjs';
export default defineConfig({testDir:'tests/e2e',use:{baseURL:assertLoopbackBaseUrl(process.env.PLAYWRIGHT_BASE_URL??'http://127.0.0.1:4173'),serviceWorkers:'block'},workers:1});
// Intentionally no webServer: the review configuration cannot start a listener.
