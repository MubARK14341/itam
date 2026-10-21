import fs from 'node:fs';
import path from 'node:path';
import inventory from './fixtures/source-inventory.json' with { type: 'json' };

const reportPaths = process.argv.slice(2);
if (!reportPaths.length) throw new Error('Pass preserved Playwright JSON report paths from the final frozen build.');
const sourceKeys = new Map(inventory.actions.map(action => [action.key, action]));
const executed = new Map();
const reports = [];
const binaries = new Set();
const gaps = [];
function payload(result, name) {
  const attachment = (result.attachments ?? []).find(item => item.name === name);
  if (!attachment) return null;
  if (attachment.contentType !== 'application/json') throw new Error(`Invalid ${name} attachment type.`);
  return JSON.parse(attachment.body ? Buffer.from(attachment.body, 'base64').toString('utf8') : fs.readFileSync(attachment.path, 'utf8'));
}
for (const reportPath of reportPaths) {
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  reports.push({ report: reportPath, stats: report.stats });
  function visit(suite) {
    for (const spec of suite.specs ?? []) for (const test of spec.tests ?? []) {
      if (test.status !== 'expected' || test.expectedStatus !== 'passed' || test.results.length !== 1 || test.results[0].status !== 'passed') {
        gaps.push({ file: spec.file, title: spec.title, status: test.status });
        continue;
      }
      const result = test.results[0], proof = payload(result, 'demo-source-actions-ui');
      if (!proof) continue;
      const audit = payload(result, 'demo-browser-audit'), binding = payload(result, 'demo-build-binding');
      if (proof.channel !== 'ui' || !Array.isArray(proof.sourceActionKeys) || !proof.oracle || !audit || !binding) throw new Error(`Incomplete UI proof: ${spec.title}`);
      if (audit.errors.length || audit.failed.length || audit.offOrigin.length || binding.pageClosed) throw new Error(`Failed browser audit: ${spec.title}`);
      const url = new URL(binding.baseURL);
      if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('Expected the local independent production preview.');
      const entry = binding.scripts.filter(script => /^\/assets\/index-[A-Za-z0-9_-]+\.js$/.test(script));
      if (entry.length !== 1) throw new Error(`UI action proof must use one actual Vite production entry: ${spec.title}`);
      const stylesheet = binding.stylesheets?.filter(stylesheet => /^\/assets\/index-[A-Za-z0-9_-]+\.css$/.test(stylesheet)) ?? [];
      if (stylesheet.length !== 1) throw new Error(`UI action proof must bind one actual Vite production stylesheet: ${spec.title}`);
      binaries.add(`${url.origin}${entry[0]}|${stylesheet[0]}`);
      for (const key of proof.sourceActionKeys) {
        if (!sourceKeys.get(key)?.mounted) throw new Error(`Unknown or unmounted UI action proof: ${key}`);
        const evidence = { report: reportPath, file: spec.file, title: spec.title, oracle: proof.oracle, browserVersion: binding.browserVersion, productionEntry: entry[0], productionStylesheet: stylesheet[0] };
        executed.set(key, [...(executed.get(key) ?? []), evidence]);
      }
    }
    for (const child of suite.suites ?? []) visit(child);
  }
  for (const suite of report.suites ?? []) visit(suite);
}
if (binaries.size > 1) throw new Error('Reports are from different production entries or stylesheets; do not combine stale builds as final coverage.');
const actions = inventory.actions.map(action => ({ ...action, demoEvidence: !action.mounted ? 'not-applicable' : executed.has(action.key) ? 'passed-ui-action' : 'unproven', passedUiCases: executed.get(action.key) ?? [] }));
const missing = actions.filter(action => action.mounted && action.demoEvidence !== 'passed-ui-action').map(action => action.key);
const output = { status: missing.length || gaps.length ? 'INCOMPLETE' : 'PASS_ALL_MOUNTED_SOURCE_ACTIONS', limits: ['Source action inventory is a minimum: unnamed callbacks, role combinations, accessibility and publication have separate gates.', 'SDK RPC and heading-only render cases never count as executed UI source actions.', 'Production entry proves the observed bundle, not deployment or main-app performance acceptance.'], reports, productionEntries: [...binaries], mounted: actions.filter(action => action.mounted).length, passedUiActions: executed.size, notApplicable: actions.filter(action => !action.mounted).length, missing, nonpassingCases: gaps, actions };
const outputDirectory = path.join('artifacts', 'demo-browser');
fs.mkdirSync(outputDirectory, { recursive: true });
fs.writeFileSync(path.join(outputDirectory, 'final-source-action-coverage.json'), `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify({ status: output.status, mounted: output.mounted, passedUiActions: output.passedUiActions, notApplicable: output.notApplicable, missing, nonpassingCases: gaps }, null, 2));
