'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createReadGateway, createCurrentOwnerAdapters, queryCone } = require('../src/pai-read-gateway');

const continuity = () => ({ status: 'VERIFIED', available: true, lifecycleStage: 'RUNNING', evidence: [{ kind: 'QCHECK', status: 'PASS' }], raw: 'must-not-project' });
const owners = createCurrentOwnerAdapters({ continuity });
const projectRoot=path.resolve(__dirname,'..','..','..');
const pointerPath=path.join(projectRoot,'06_STATE','PAI_ACTIVE_ARCHITECTURE_POINTER.json');
assert.equal(fs.existsSync(pointerPath),false,'personal architecture pointer is runtime/Mind state, not canonical source');
const adapterContract=fs.readFileSync(path.join(projectRoot,'CORE','TCD','manifests','PAI_PROJECT_ADAPTER_v1.0_ACTIVE.md'),'utf8');
for(const role of ['Active PAI Mind V1','Chat+Agent Operating Contract V1','PAI Quick Check V1','Unified Final Plan V1'])assert.doesNotMatch(adapterContract,new RegExp(`\\| ${role} \\|[^\\n]*\\| every (?:new/resumed )?PAI chat`));
const gateway = createReadGateway({ owners, catalog: [
  { id: 'semantic:farm', title: 'Farm Architecture', url: 'pai://farm', cones: ['FARM'], classification: 'STATIC_SEMANTIC', authority: 'FIXTURE', provenance: { version: 'v1' }, text: 'farm source v1' },
  { id: 'semantic:publication', title: 'Publication Contract', url: 'pai://publication', cones: ['PUBLICATION'], classification: 'STATIC_SEMANTIC', authority: 'FIXTURE', provenance: { version: 'v1' }, text: 'publication source v1' },
  { id: 'semantic:farm', title: 'Duplicate Farm Architecture', url: 'pai://farm-duplicate', cones: ['FARM'], classification: 'STATIC_SEMANTIC', authority: 'FIXTURE', provenance: { version: 'v1' }, text: 'must dedupe' }
] });

assert.equal(queryCone('cone:FARM architecture').cone, 'FARM');
assert.equal(queryCone('publish the website').cone, 'PUBLICATION');

const farm = gateway.call('search', { query: 'cone:FARM farm' }).structuredContent;
assert.equal(farm.cone, 'FARM');
assert.equal(farm.scopeExpanded, false);
assert.deepEqual(farm.results.map(row => row.id), ['semantic:farm']);
assert.equal(farm.dedupedCount, 0);
assert.equal(farm.conflictCount, 1);
assert.equal(farm.results.some(row => row.id === 'semantic:publication'), false);

const first = gateway.call('fetch', { id: 'semantic:farm' }).structuredContent;
const repeated = gateway.call('fetch', { id: 'semantic:farm' }).structuredContent;
const recovered = gateway.call('fetch', { id: 'semantic:farm', mode: 'FULL' }).structuredContent;
assert.equal(first.text, null);
assert.equal(first.metadata.pointerOnly, true);
assert.equal(repeated.text, null);
assert.equal(repeated.metadata.deduped, true);
assert.equal(recovered.text, 'farm source v1');

gateway.call('pai_resume', {});
const budget = gateway.call('fetch', { id: 'jit:context-budget', mode: 'FULL' }).structuredContent;
const report = JSON.parse(budget.text);
assert.equal(report.schema, 'pai-context-budget/v2');
assert.equal(report.status, 'MEASURED_PAI_CONTROLLED_ONLY');
assert.ok(report.totals.requests >= 5);
assert.ok(report.totals.deduped_count >= 1);
assert.equal(report.layers.HISTORY, null);
assert.equal(report.layers.UNKNOWN_PLATFORM, null);
assert.ok(report.hostUnavailable.includes('HISTORY'));
assert.ok(report.recent_events.length <= 10);
assert.ok(report.by_tool.fetch.requests >= 3);
assert.ok(report.totals.tool_result_bytes > 0);

console.log('context-economy-r2: PASS thin boot, scoped JIT, source dedupe, FULL recovery, and budget telemetry');
