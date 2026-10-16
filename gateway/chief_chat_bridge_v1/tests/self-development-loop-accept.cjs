'use strict';

// Checkpoint B acceptance.
// Creates one disposable failing fixture, then lets ChatGPT plan and
// FederationCore/host-control act. This process does not edit the fixture
// after the loop starts.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.CHATGPT_WEB_ENABLED = '1';

const { FederationCore } = require('../src/federation-core');
const { ChatGPTWebProviderAdapter } = require('../src/chatgpt-web-adapter');
const {
  LoopError,
  parseProviderAction,
  validateAction,
  runSelfDevelopmentLoop
} = require('../src/self-development-loop');

const ADD_JS = "'use strict';\nfunction add(a, b) {\n  return a - b;\n}\nmodule.exports = { add };\n";
const TEST_JS = [
  "'use strict';",
  "const test = require('node:test');",
  "const assert = require('node:assert/strict');",
  "const { add } = require('./add');",
  "test('add sums two numbers', () => {",
  '  assert.equal(add(2, 3), 5);',
  '});',
  ''
].join('\n');

function assertParser() {
  const read = parseProviderAction('{"action":"READ","target":"add.js","payload":"","reason":"look","done":false}');
  if (read.action !== 'READ' || read.target !== 'add.js') throw new Error('parser read');
  const state = { reads: new Set(), wrote: false, passAfterWrite: false, lastModuleText: '' };
  let blocked = false;
  try {
    validateAction({ action: 'WRITE_CANDIDATE', target: 'add.js', payload: ADD_JS, reason: '', done: false }, state);
  } catch (err) {
    blocked = err instanceof LoopError && err.code === 'ACTION_NOT_ALLOWED';
  }
  if (!blocked) throw new Error('write-before-read was allowed');
  state.reads.add('add.js');
  state.lastModuleText = ADD_JS.trim();
  validateAction({
    action: 'WRITE_CANDIDATE',
    target: 'add.js',
    payload: ADD_JS.replace('-', '+'),
    reason: 'fix',
    done: false
  }, state);
  let doneBlocked = false;
  try {
    validateAction({ action: 'DONE', target: '', payload: '', reason: 'no', done: true }, state);
  } catch (err) {
    doneBlocked = err.code === 'DONE_WITHOUT_PASS';
  }
  if (!doneBlocked) throw new Error('done-without-pass was allowed');
  let escaped = false;
  try {
    validateAction({ action: 'READ', target: '..\\add.js', payload: '', reason: '', done: false }, state);
  } catch (err) {
    escaped = err.code === 'SCOPE_DENIED';
  }
  if (!escaped) throw new Error('escape target was allowed');
}

function createFixture() {
  const id = `sdl-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomBytes(3).toString('hex')}`;
  const root = path.join(os.tmpdir(), 'pai_candidate_workspaces', id);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'add.js'), ADD_JS, 'utf8');
  fs.writeFileSync(path.join(root, 'add.test.js'), TEST_JS, 'utf8');
  return { id, root };
}

async function main() {
  assertParser();
  const fixture = createFixture();
  const core = new FederationCore();
  const adapter = new ChatGPTWebProviderAdapter();
  const logPath = path.join(fixture.root, 'accept.log');
  const log = (line) => {
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
  };

  async function executeHost(spec) {
    const requestId = `sdl-${crypto.randomBytes(6).toString('hex')}`;
    log(`HOST ${spec.intent} ${spec.command.slice(0, 80)}`);
    return core.handleActionRun({
      request_id: requestId,
      intent: spec.intent,
      command: spec.command,
      objective: spec.intent,
      effect_class: spec.effect_class,
      scope: fixture.root,
      timeout_seconds: spec.timeout_seconds || 60,
      network: 'DENY',
      action_payload: {
        command: spec.command,
        cwd: fixture.root,
        target_path: spec.target_path,
        scope: fixture.root
      }
    });
  }

  async function invokeProvider(prepared) {
    log(`PROVIDER turn key=${prepared.idempotency_key} chars=${prepared.objective.length}`);
    return adapter.invokeCognition(prepared);
  }

  let outcome;
  try {
    outcome = await runSelfDevelopmentLoop({
      fixtureRoot: fixture.root,
      executeHost,
      invokeProvider,
      maxTurns: 6
    });
    outcome.pass = true;
  } catch (err) {
    outcome = {
      pass: false,
      code: err && err.code ? err.code : 'EXECUTION_FAILED',
      message: err && err.message ? err.message : String(err),
      fixtureRoot: fixture.root,
      turns: err.turns || [],
      receipts: err.receipts || []
    };
    log(`STOP ${outcome.code} ${outcome.message}`);
  } finally {
    await ChatGPTWebProviderAdapter.closeBrowser();
  }

  const finalModule = fs.readFileSync(path.join(fixture.root, 'add.js'), 'utf8');
  const record = {
    fixture_id: fixture.id,
    fixture_root: fixture.root,
    pass: outcome.pass === true,
    code: outcome.pass ? 'SELF_DEVELOPMENT_LOOP_PASS' : outcome.code,
    message: outcome.message || '',
    provider_turns: (outcome.turns || []).length,
    deterministic_steps: (outcome.receipts || []).length,
    turns: outcome.turns || [],
    receipts: outcome.receipts || [],
    final_add_js: finalModule,
    executors: [...new Set((outcome.receipts || []).map(r => r.observation && r.observation.executor).filter(Boolean))]
  };
  fs.writeFileSync(path.join(fixture.root, 'loop-result.json'), JSON.stringify(record, null, 2));
  const outCopy = path.join(__dirname, '..', 'scratch', 'provider-v0-bootstrap-evidence', 'b-preimage-20260923T135315Z', `${fixture.id}-loop-result.json`);
  try { fs.copyFileSync(path.join(fixture.root, 'loop-result.json'), outCopy); } catch (_) {}
  process.stdout.write(`${record.pass ? 'SELF_DEVELOPMENT_LOOP_PASS: CONFIRMED' : 'NOT_DONE:' + record.code}\n`);
  process.stdout.write(`FIXTURE ${fixture.id}\n`);
  process.stdout.write(`TURNS ${record.provider_turns} STEPS ${record.deterministic_steps}\n`);
  process.exit(record.pass ? 0 : 1);
}

main().catch(err => {
  process.stderr.write(`ACCEPT_FATAL ${err && err.message ? err.message : err}\n`);
  process.exit(1);
});
