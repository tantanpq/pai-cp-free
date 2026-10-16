'use strict';

// Thin seam. ChatGPT chooses an action. The target must come from the Lens.
// FederationCore host-control performs the read, write, or test. No raw shell.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { buildProjectLens, assertLensPath, sha256 } = require('./project-lens');
const { ChatGPTWebProviderAdapter } = require('./chatgpt-web-adapter');
const { FederationCore } = require('./federation-core');

function git(cwd, args) {
  const result = spawnSync('git', ['-c', 'user.email=lens@local', '-c', 'user.name=lens', ...args], {
    cwd, encoding: 'utf8', windowsHide: true
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'git failed');
}

function parseJson(text) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw typed('PROVIDER_OUTPUT_INVALID');
  try { return JSON.parse(raw.slice(start, end + 1)); }
  catch (_) { throw typed('PROVIDER_OUTPUT_INVALID'); }
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function makeReadFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pai-readonly-'));
  spawnSync('git', ['init'], { cwd: root, encoding: 'utf8' });
  fs.writeFileSync(path.join(root, 'note.txt'), 'accepted\n');
  git(root, ['add', 'note.txt']);
  git(root, ['commit', '-m', 'accepted']);
  fs.appendFileSync(path.join(root, 'note.txt'), 'local-delta\n');
  return root;
}

function makeEditFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pai-edit-'));
  spawnSync('git', ['init'], { cwd: root, encoding: 'utf8' });
  fs.writeFileSync(path.join(root, 'item.js'), "'use strict';\nmodule.exports = (a, b) => a + b;\n");
  fs.writeFileSync(path.join(root, 'item.test.js'), "'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert/strict');\nconst add = require('./item');\ntest('sum', () => { assert.equal(add(2, 3), 5); });\n");
  git(root, ['add', 'item.js', 'item.test.js']);
  git(root, ['commit', '-m', 'accepted']);
  fs.writeFileSync(path.join(root, 'item.js'), "'use strict';\nmodule.exports = (a, b) => a - b;\n");
  return root;
}

async function host(core, root, spec) {
  const result = await core.handleActionRun({
    request_id: `lens-${crypto.randomBytes(4).toString('hex')}`,
    intent: spec.intent,
    command: spec.command,
    objective: spec.intent,
    effect_class: spec.effect_class,
    scope: root,
    timeout_seconds: spec.timeout_seconds || 60,
    network: 'DENY',
    action_payload: { command: spec.command, cwd: root, target_path: spec.target_path, scope: root }
  });
  if (result.selected_executor_if_assigned && result.selected_executor_if_assigned !== 'DETERMINISTIC_HOST') {
    throw new Error(`NON_DETERMINISTIC_EXECUTOR:${result.selected_executor_if_assigned}`);
  }
  return result;
}

function readSpec(root, relativePath) {
  const target = path.join(root, relativePath);
  return {
    intent: 'FILESYSTEM_READ',
    effect_class: 'NO_MATERIAL_DELTA',
    command: `Get-Content -LiteralPath ${psQuote(target)} -Raw`,
    target_path: target
  };
}

function normalizeBody(text) {
  return String(text || '').replace(/\u0000/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function typed(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

function validateCandidateBytes(currentText, payload) {
  const next = normalizeBody(payload);
  if (!next.trim() || next.length > 2000 || /child_process|eval\s*\(|https?:|powershell|cmd\.exe/i.test(next)) {
    throw typed('ACTION_NOT_ALLOWED');
  }
  if (normalizeBody(currentText).trim() === next.trim()) throw typed('NO_MATERIAL_DELTA');
  return next;
}

function applyPatch(currentText, payload) {
  let patch;
  try { patch = JSON.parse(payload); } catch (_) { throw typed('ACTION_NOT_ALLOWED'); }
  if (!patch || typeof patch.find !== 'string' || typeof patch.replace !== 'string' || !patch.find) {
    throw typed('ACTION_NOT_ALLOWED');
  }
  const current = normalizeBody(currentText);
  if (current.split(patch.find).length !== 2) throw typed('ACTION_NOT_ALLOWED');
  return current.replace(patch.find, patch.replace);
}

function gateDone(state, requireTest) {
  if (requireTest && !(state.wrote && state.testExit === 0)) throw typed('DONE_WITHOUT_PASS');
}

const CANONICAL_ACTIONS = new Set([
  'READ', 'WRITE_CANDIDATE', 'APPLY_PATCH', 'RUN', 'DONE',
  'RESULT', 'REQUEST_EVIDENCE', 'DIFF', 'READ_OUTPUT'
]);
const TARGET_ACTIONS = new Set(['READ', 'WRITE_CANDIDATE', 'APPLY_PATCH', 'RUN', 'REQUEST_EVIDENCE', 'DIFF']);

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeProviderAction(value) {
  if (!plainObject(value)) throw typed('PROVIDER_OUTPUT_INVALID');
  const keys = Object.keys(value);
  const nestedActionKeys = keys.filter(key => CANONICAL_ACTIONS.has(key) && plainObject(value[key]));
  const unknownNested = keys.filter(key => !CANONICAL_ACTIONS.has(key) && key !== 'source_identity' && plainObject(value[key]));
  const flatName = typeof value.action === 'string' ? value.action.trim().toUpperCase() : '';
  if (flatName && (nestedActionKeys.length || unknownNested.length)) throw typed('PROVIDER_OUTPUT_INVALID');
  if (nestedActionKeys.length > 1 || unknownNested.length > 1) throw typed('PROVIDER_OUTPUT_INVALID');
  if (nestedActionKeys.length && unknownNested.length) throw typed('PROVIDER_OUTPUT_INVALID');
  if (!flatName && unknownNested.length === 1 && nestedActionKeys.length === 0) throw typed('ACTION_NOT_ALLOWED');
  if (!flatName && nestedActionKeys.length === 0) throw typed('PROVIDER_OUTPUT_INVALID');

  const nested = nestedActionKeys.length === 1;
  const actionName = nested ? nestedActionKeys[0] : (flatName === 'RESULT' ? 'DONE' : flatName);
  if (!CANONICAL_ACTIONS.has(actionName) && actionName !== 'DONE') throw typed('ACTION_NOT_ALLOWED');
  const source = nested ? value[nestedActionKeys[0]] : value;
  const canonicalAction = actionName === 'RESULT' ? 'DONE' : actionName;
  const target = String(source.target || source.ref || '');
  const payload = String(source.payload != null ? source.payload : (source.content != null ? source.content : ''));
  if (TARGET_ACTIONS.has(canonicalAction) && !target) throw typed('ACTION_NOT_ALLOWED');
  return {
    action: canonicalAction,
    target,
    payload,
    reason: String(source.reason || ''),
    done: source.done === true || value.done === true
  };
}

function writeSpec(root, relativePath, content) {
  const target = path.join(root, relativePath);
  return {
    intent: 'FILESYSTEM_EDIT',
    effect_class: 'CANDIDATE_DRAFT',
    command: `[System.IO.File]::WriteAllText(${psQuote(target)}, ${psQuote(content)})`,
    target_path: target
  };
}

function runSpec(root, relativePath) {
  if (!/^[A-Za-z0-9._-]+$/.test(relativePath)) {
    const err = new Error('ACTION_NOT_ALLOWED');
    err.code = 'ACTION_NOT_ALLOWED';
    throw err;
  }
  return {
    intent: 'TERMINAL_COMMAND',
    effect_class: 'NO_MATERIAL_DELTA',
    command: `node --test ${relativePath}`,
    target_path: path.join(root, relativePath),
    timeout_seconds: 60
  };
}

async function ask(adapter, key, objective, sourceRef) {
  return adapter.invokeCognition({
    run_id: `run:${key}`,
    objective,
    reasoning_type: 'PLAN',
    idempotency_key: key,
    artifact_policy: 'INLINE',
    source_refs: [sourceRef]
  });
}

function capsulePrompt(lens) {
  return [
    'You have a Project Capsule only. Do not guess file bodies.',
    'Reply with ONE JSON object only.',
    'Use exactly {"action":"READ|WRITE_CANDIDATE|APPLY_PATCH|RUN|DONE","target":"","payload":"","reason":"","done":false}.',
    'Do not wrap the action name around another object.',
    'Copy target from affected_files or tracked_files.',
    'A path that is not in the capsule is invalid.',
    JSON.stringify({
      base_commit: lens.capsule.base_commit,
      diff_hash: lens.capsule.diff_hash,
      worktree: lens.capsule.worktree,
      affected_files: lens.capsule.affected_files,
      tracked_files: lens.capsule.tracked_files,
      objective: lens.capsule.objective
    })
  ].join('\n');
}

async function runLensLoop({ root, objective, acceptResult, requireTest = false, maxTurns = 6 }) {
  const lens = buildProjectLens(root, { projectId: path.basename(root), objective, resultRefs: ['PROVIDER_V0_RESULT.md'] });
  const core = new FederationCore();
  const adapter = new ChatGPTWebProviderAdapter();
  const state = { reads: new Set(), wrote: false, testExit: null, observation: '', fileText: '', executor: null };
  const turns = [];
  const sourceRef = `git:${lens.capsule.base_commit}`;
  try {
    for (let turn = 1; turn <= maxTurns; turn += 1) {
      const prompt = state.observation
        ? [
          'Observation from DETERMINISTIC_HOST follows. Reply with ONE JSON object.',
          'Reply with ONE flat JSON object: {"action":"READ|WRITE_CANDIDATE|APPLY_PATCH|RUN|DONE","target":"","payload":"","reason":"","done":false}.',
          'Do not wrap the action name around another object.',
          'If the source fails the test, do not write identical content. A WRITE_CANDIDATE must change the file. After a successful write, RUN the tracked test. DONE only after that test exits 0.',
          `base_commit=${lens.capsule.base_commit}`,
          `diff_hash=${lens.capsule.diff_hash}`,
          state.observation,
          state.fileText ? `FILE_TEXT:\n${state.fileText}` : ''
        ].filter(Boolean).join('\n')
        : capsulePrompt(lens);
      if (turn > 1 && process.env.PAI_LIVE_PROVIDER === '1') {
        await new Promise(resolve => setTimeout(resolve, 90000));
      }
      let response;
      try {
        response = await ask(adapter, `${path.basename(root)}-turn-${turn}`, prompt, sourceRef);
      } catch (err) {
        const code = err && err.code;
        if (code === 'CHATGPT_TIMEOUT' || code === 'CHATGPT_RATE_LIMITED' || code === 'CHATGPT_HUMAN_CHALLENGE' || code === 'CHATGPT_AUTH_REQUIRED' || code === 'CHATGPT_RESPONSE_EMPTY') {
          throw err;
        }
        throw err;
      }
      turns.push({ turn, chars: String(response.candidate_content || '').length, text: String(response.candidate_content || '').slice(0, 240) });
      let action;
      try { action = normalizeProviderAction(parseJson(response.candidate_content)); }
      catch (err) { state.observation = err.code || 'PROVIDER_OUTPUT_INVALID'; continue; }
      const name = action.action;
      try {
        if (name === 'READ' || name === 'REQUEST_EVIDENCE') {
          const target = assertLensPath(lens, action.target || action.ref);
          const receipt = await host(core, root, readSpec(root, target));
          state.executor = receipt.selected_executor_if_assigned || 'DETERMINISTIC_HOST';
          state.reads.add(target);
          state.fileText = String(receipt.host_control_receipt?.key_output || '');
          let testEvidence = '';
          const testName = target.endsWith('.js') ? target.replace(/\.js$/, '.test.js') : '';
          if (testName && (lens.capsule.tracked_files || []).includes(testName)) {
            const testReceipt = await host(core, root, readSpec(root, testName));
            testEvidence = `\nTEST ${testName} exit=${testReceipt.host_control_receipt?.exit_code}\n${testReceipt.host_control_receipt?.key_output || ''}`;
          }
          state.observation = `READ ${target} exit=${receipt.host_control_receipt?.exit_code}\n${state.fileText}${testEvidence}`;
          continue;
        }
        if (name === 'WRITE_CANDIDATE' || name === 'APPLY_PATCH') {
          const target = assertLensPath(lens, action.target);
          if (!state.reads.has(target)) throw typed('ACTION_NOT_ALLOWED');
          const current = fs.readFileSync(path.join(root, target), 'utf8');
          const payload = name === 'APPLY_PATCH'
            ? applyPatch(current, action.payload)
            : action.payload;
          const next = validateCandidateBytes(current, payload);
          const receipt = await host(core, root, writeSpec(root, target, next));
          state.executor = receipt.selected_executor_if_assigned || 'DETERMINISTIC_HOST';
          state.wrote = receipt.host_control_receipt?.status === 'SUCCESS';
          state.fileText = next;
          state.testExit = null;
          state.observation = `WRITE ${target} status=${receipt.host_control_receipt?.status}`;
          continue;
        }
        if (name === 'RUN') {
          const target = assertLensPath(lens, action.target);
          const receipt = await host(core, root, runSpec(root, target));
          state.executor = receipt.selected_executor_if_assigned || 'DETERMINISTIC_HOST';
          state.testExit = receipt.host_control_receipt?.exit_code;
          state.observation = `RUN ${target} exit=${state.testExit}\n${receipt.host_control_receipt?.key_output || ''}`;
          continue;
        }
        if (name === 'DONE' || name === 'RESULT') {
          const ident = action.source_identity || action;
          if (ident.base_commit !== lens.capsule.base_commit || ident.diff_hash !== lens.capsule.diff_hash) {
            state.observation = `SOURCE_IDENTITY_MISMATCH expected ${lens.capsule.base_commit} ${lens.capsule.diff_hash}`;
            continue;
          }
          try { gateDone(state, requireTest); }
          catch (err) { state.observation = err.code; continue; }
          if (!acceptResult(action, state)) { state.observation = 'DONE_WITHOUT_PASS'; continue; }
          return { lens, state, turns, action };
        }
        state.observation = 'ACTION_NOT_ALLOWED';
      } catch (err) {
        if (err.code === 'SCOPE_DENIED' || err.code === 'NO_MATERIAL_DELTA' || err.code === 'ACTION_NOT_ALLOWED' || err.code === 'DONE_WITHOUT_PASS') {
          state.observation = err.code;
          continue;
        }
        throw err;
      }
    }
  } finally {
    await ChatGPTWebProviderAdapter.closeBrowser();
  }
  const err = new Error(`LOOP_LIMIT_REACHED reads=${[...state.reads].join(',')} file=${state.fileText.length} obs=${state.observation}`);
  err.turns = turns;
  throw err;
}

async function runReadOnlyEntry() {
  const root = makeReadFixture();
  const out = await runLensLoop({
    root,
    objective: 'Read the dirty file shown by the capsule and report its source identity. Do not edit.',
    acceptResult: (_action, state) => state.reads.size > 0 && state.fileText.length > 0
  });
  return { root, ...out };
}

async function runCandidateEditEntry() {
  const root = makeEditFixture();
  const out = await runLensLoop({
    root,
    objective: 'The dirty file fails its tracked test. Read it, replace only that file, run the tracked test, and finish only after the test passes.',
    requireTest: true,
    maxTurns: 4,
    acceptResult: (_action, state) => state.wrote && state.testExit === 0
  });
  return { root, ...out };
}

if (require.main === module) {
  process.env.CHATGPT_WEB_ENABLED = '1';
  process.env.PAI_LIVE_PROVIDER = '1';
  const mode = process.argv[2] || 'read';
  const run = mode === 'edit' ? runCandidateEditEntry : runReadOnlyEntry;
  run().then(out => {
    if (out.state.executor !== 'DETERMINISTIC_HOST') throw new Error('NON_DETERMINISTIC_EXECUTOR');
    if (mode === 'edit') {
      const body = fs.readFileSync(path.join(out.root, out.lens.capsule.affected_files[0].path), 'utf8');
      if (!body.includes('a + b') || out.state.testExit !== 0) throw new Error('EDIT_NOT_VERIFIED');
    } else if (!out.state.fileText.includes('local-delta')) {
      throw new Error(`READ_NOT_VERIFIED:${JSON.stringify(out.state.fileText)}`);
    }
    process.stdout.write(`${mode === 'edit' ? 'CANDIDATE_EDIT_PASS' : 'LENS_CONTROL_PASS'}: CONFIRMED\n`);
    process.stdout.write(`PATHS ${out.lens.capsule.affected_files.map(file => file.path).join(',')}\n`);
    process.stdout.write(`EXECUTOR ${out.state.executor}\n`);
    process.stdout.write(`TURNS ${out.turns.length}\n`);
  }).catch(err => {
    process.stderr.write(`ENTRY_FAIL ${err.message}\n`);
    if (err.turns) process.stderr.write(`${JSON.stringify(err.turns)}\n`);
    process.exit(1);
  });
}

module.exports = {
  runReadOnlyEntry,
  runCandidateEditEntry,
  runLensLoop,
  validateCandidateBytes,
  gateDone,
  normalizeProviderAction,
  assertLensPath,
  parseJson,
  sha256
};
