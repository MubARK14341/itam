import {assertLoopbackBaseUrl} from './loopback-target.mjs';
assertLoopbackBaseUrl(process.env.PLAYWRIGHT_BASE_URL??'http://127.0.0.1:4173');
throw Error('Browser/database E2E is blocked pending separately permitted local runtime verification; no server or browser was started.');
