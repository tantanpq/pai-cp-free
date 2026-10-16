'use strict';

// Bounded Checkpoint B loop.
// ChatGPT chooses one action. FederationCore/host-control performs it.
// Provider text is never executed as a shell command.

const path = require('node:path');

const ACTIONS = Object.freeze([
  'READ',
  'WRITE_CANDIDATE',
  'APPLY_PATCH',
  'RUN',
  'READ_OUTPUT',
  'DIFF',
  'DONE'
]);

const READ_TARGETS = new Set(['add.js', 'add.test.js']);
const WRITE_TARGETS = new Set(['add.js']);
const RUN_TARGETS = new Set(['add.test.js']);
const MAX_PAYLOAD = 800;
const MAX_TURNS_DEFAULT = 6;

const LOOSE_MODULE_RE = /^'use strict';\s*function add\(a,\s*b\)\s*\{\s*return a ([+\-*/]) b;\s*\}\s*module\.exports = \{\s*add\s*\};$/;

class LoopError extends Error {
  constructor(code, detail) {
    super(`${code}${detail ? ': ' + detail : ''}`);
    this.name = 'LoopError';
    this.code = code;
  }
}

function canonicalizeModule(text) {
  const cleaned = String(text || '')
    .replace(/\u0000/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
  const match = LOOSE_MODULE_RE.exec(cleaned);
  if (!match) return cleaned;
  return `'use strict';\nfunction add(a, b) {\n  return a ${match[1]} b;\n}\nmodule.exports = { add };`;
}

function moduleOperator(text) {
  const match = LOOSE_MODULE_RE.exec(canonicalizeModule(text));
  return match ? match[1] : null;
}

function parseProviderAction(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new LoopError('PROVIDER_OUTPUT_INVALID', 'empty provider output');
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1].trim() : raw;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new LoopError('PROVIDER_OUTPUT_INVALID', 'no JSON object');
  }
  let parsed;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch (_) {
    throw new LoopError('PROVIDER_OUTPUT_INVALID', 'JSON parse failed');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LoopError('PROVIDER_OUTPUT_INVALID', 'JSON value is not an object');
  }
  const action = String(parsed.action || '').trim().toUpperCase();
  if (!ACTIONS.includes(action)) {
    throw new LoopError('ACTION_NOT_ALLOWED', `action ${action || '(missing)'} is not in the vocabulary`);
  }
  return {
    action,
    target: String(parsed.target || '').trim(),
    payload: String(parsed.payload == null ? '' : parsed.payload),
    reason: String(parsed.reason || '').slice(0, 240),
    done: parsed.done === true
  };
}

function assertSafeTarget(target) {
  if (!target) return;
  if (target.length > 32 || /[\\/:]/.test(target) || target.includes('..')) {
    throw new LoopError('SCOPE_DENIED', 'target must be a fixture file name');
  }
}

function assertSafePayload(payload) {
  if (payload.length > MAX_PAYLOAD) {
    throw new LoopError('PROVIDER_OUTPUT_INVALID', 'payload exceeds bound');
  }
  if (/child_process|eval\s*\(|new Function|https?:|cookie|password|authorization|\\\\\.ssh|cmd\.exe|powershell/i.test(payload)) {
    throw new LoopError('ACTION_NOT_ALLOWED', 'payload is outside the fixture contract');
  }
}

function validateAction(action, state) {
  assertSafeTarget(action.target);
  assertSafePayload(action.payload);
  if (action.action === 'READ' && !READ_TARGETS.has(action.target)) {
    throw new LoopError('SCOPE_DENIED', 'READ target must be add.js or add.test.js');
  }
  if ((action.action === 'WRITE_CANDIDATE' || action.action === 'APPLY_PATCH') && !WRITE_TARGETS.has(action.target)) {
    throw new LoopError('SCOPE_DENIED', 'writes are limited to add.js');
  }
  if (action.action === 'RUN' && !RUN_TARGETS.has(action.target)) {
    throw new LoopError('SCOPE_DENIED', 'RUN target must be add.test.js');
  }
  if (action.action === 'DIFF' && action.target !== 'add.js') {
    throw new LoopError('SCOPE_DENIED', 'DIFF target must be add.js');
  }
  if ((action.action === 'WRITE_CANDIDATE' || action.action === 'APPLY_PATCH') && !state.reads.has('add.js')) {
    throw new LoopError('ACTION_NOT_ALLOWED', 'READ add.js before writing');
  }
  if (action.action === 'WRITE_CANDIDATE' && !moduleOperator(action.payload)) {
    throw new LoopError('PROVIDER_OUTPUT_INVALID', 'WRITE_CANDIDATE payload must be the add.js shape with operator + - * or /');
  }
  if (action.action === 'APPLY_PATCH') {
    let patch;
    try { patch = JSON.parse(action.payload); } catch (_) { patch = null; }
    if (!patch || typeof patch.find !== 'string' || typeof patch.replace !== 'string') {
      throw new LoopError('PROVIDER_OUTPUT_INVALID', 'APPLY_PATCH payload must be {"find":"...","replace":"..."}');
    }
    if (!state.reads.has('add.js') || !state.lastModuleText) {
      throw new LoopError('ACTION_NOT_ALLOWED', 'READ add.js before APPLY_PATCH');
    }
    const count = state.lastModuleText.split(patch.find).length - 1;
    if (count !== 1) {
      throw new LoopError('ACTION_NOT_ALLOWED', 'find text must match add.js exactly once');
    }
    const next = state.lastModuleText.replace(patch.find, patch.replace);
    if (!moduleOperator(next)) {
      throw new LoopError('PROVIDER_OUTPUT_INVALID', 'patch result is outside the add.js shape');
    }
  }
  if (action.action === 'DONE') {
    if (action.done !== true) {
      throw new LoopError('PROVIDER_OUTPUT_INVALID', 'DONE requires done true');
    }
    if (!state.passAfterWrite) {
      throw new LoopError('DONE_WITHOUT_PASS', 'DONE is allowed only after a passing test that follows a write');
    }
  }
}

function cleanText(text) {
  return String(text || '').replace(/\u0000/g, '').replace(/\r\n/g, '\n').trim();
}

function observationFromResult(action, result) {
  const receipt = result && (result.host_control_receipt || result.receipt) || {};
  const output = cleanText(receipt.key_output).slice(0, 1200);
  const stderr = cleanText(receipt.stderr_summary).slice(0, 400);
  return {
    action,
    executor: result.selected_executor_if_assigned || 'DETERMINISTIC_HOST',
    status: receipt.status || result.status || 'UNKNOWN',
    exit_code: receipt.exit_code,
    output,
    stderr,
    request_id: result.request_id || null,
    operation_id: receipt.operation_id || null
  };
}

function formatObservation(obs) {
  return [
    `action=${obs.action}`,
    `executor=${obs.executor}`,
    `status=${obs.status}`,
    `exit_code=${obs.exit_code}`,
    'output:',
    obs.output || '(empty)',
    obs.stderr ? `stderr:\n${obs.stderr}` : ''
  ].filter(Boolean).join('\n').slice(0, 1800);
}

function buildPrompt(state) {
  return [
    'You are the cognition step of a bounded PAI loop. Reply with ONE JSON object and no other text.',
    'Schema: {"action":"READ|WRITE_CANDIDATE|APPLY_PATCH|RUN|READ_OUTPUT|DIFF|DONE","target":"","payload":"","reason":"short","done":false}',
    'Files: add.js (module) and add.test.js (test). No shell, no other paths.',
    'READ target is add.js or add.test.js. RUN target is add.test.js. DIFF target is add.js.',
    'WRITE_CANDIDATE target is add.js. Its payload is the full module. The only legal module is:',
    "'use strict';",
    'function add(a, b) {',
    '  return a OP b;',
    '}',
    'module.exports = { add };',
    'OP is one of + - * / and must stay on that line. You may not change the test.',
    'APPLY_PATCH payload is {"find":"exact text","replace":"exact text"} and must leave that same shape.',
    'WRITE and APPLY_PATCH are rejected until you have READ add.js.',
    'DONE is rejected until a RUN of add.test.js exits 0 after a write. DONE uses done true and an empty payload.',
    `Already read: ${[...state.reads].join(',') || 'none'}.`,
    `Write happened: ${state.wrote ? 'yes' : 'no'}. Passing run after latest write: ${state.passAfterWrite ? 'yes' : 'no'}.`,
    'Latest observation:',
    state.lastObservation || '(none)'
  ].join('\n');
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function fileInFixture(fixtureRoot, name) {
  const abs = path.resolve(fixtureRoot, name);
  const root = path.resolve(fixtureRoot);
  if (abs !== path.join(root, name)) {
    throw new LoopError('SCOPE_DENIED', 'resolved path escaped the fixture');
  }
  return abs;
}

function commandFor(action, fixtureRoot, moduleText) {
  if (action.action === 'READ' || action.action === 'DIFF') {
    const abs = fileInFixture(fixtureRoot, action.target);
    const command = action.action === 'DIFF'
      ? `Get-FileHash -LiteralPath ${psQuote(abs)} -Algorithm SHA256 | Select-Object -ExpandProperty Hash`
      : `Get-Content -LiteralPath ${psQuote(abs)} -Raw`;
    return {
      intent: 'FILESYSTEM_READ',
      effect_class: 'NO_MATERIAL_DELTA',
      command,
      target_path: abs,
      timeout_seconds: 30
    };
  }
  if (action.action === 'RUN') {
    return {
      intent: 'TERMINAL_COMMAND',
      effect_class: 'NO_MATERIAL_DELTA',
      command: 'node --test add.test.js',
      target_path: fileInFixture(fixtureRoot, 'add.test.js'),
      timeout_seconds: 60
    };
  }
  if (action.action === 'WRITE_CANDIDATE' || action.action === 'APPLY_PATCH') {
    const next = action.action === 'WRITE_CANDIDATE'
      ? canonicalizeModule(action.payload)
      : canonicalizeModule(moduleText);
    const abs = fileInFixture(fixtureRoot, 'add.js');
    return {
      intent: 'FILESYSTEM_EDIT',
      effect_class: 'CANDIDATE_DRAFT',
      command: `[System.IO.File]::WriteAllText(${psQuote(abs)}, ${psQuote(next + '\n')})`,
      target_path: abs,
      timeout_seconds: 30,
      nextText: next
    };
  }
  throw new LoopError('ACTION_NOT_ALLOWED', action.action);
}

async function executeSpec(executeHost, spec) {
  let result;
  try {
    result = await executeHost(spec);
  } catch (err) {
    if (err instanceof LoopError) throw err;
    throw new LoopError('EXECUTION_FAILED', err && err.message ? err.message : 'host execution failed');
  }
  const executor = result && result.selected_executor_if_assigned;
  if (executor && executor !== 'DETERMINISTIC_HOST') {
    throw new LoopError('EXECUTION_FAILED', `executor ${executor} is not deterministic host control`);
  }
  if (result && (result.status === 'DENIED' || result.chief_state === 'DENIED')) {
    const code = String(result.denial_code || '');
    if (code.includes('SCOPE')) throw new LoopError('SCOPE_DENIED', result.reason || code);
    throw new LoopError('ACTION_NOT_ALLOWED', result.reason || code || 'host denied the action');
  }
  return result;
}

function noteSuccess(state, action, obs, spec) {
  if (action.action === 'READ' && action.target === 'add.js') {
    state.reads.add('add.js');
    state.lastModuleText = canonicalizeModule(obs.output);
  } else if (action.action === 'READ') {
    state.reads.add(action.target);
  }
  if (action.action === 'WRITE_CANDIDATE' || action.action === 'APPLY_PATCH') {
    if (obs.status !== 'SUCCESS') {
      throw new LoopError('EXECUTION_FAILED', 'write did not succeed');
    }
    state.wrote = true;
    state.passAfterWrite = false;
    state.lastModuleText = spec.nextText;
  }
  if (action.action === 'RUN' && state.wrote && obs.exit_code === 0 && obs.status === 'SUCCESS') {
    state.passAfterWrite = true;
  }
  if (action.action === 'READ' && obs.status !== 'SUCCESS') {
    throw new LoopError('OBSERVATION_INVALID', 'read did not succeed');
  }
}

async function runSelfDevelopmentLoop(options) {
  const fixtureRoot = options.fixtureRoot;
  const maxTurns = options.maxTurns || MAX_TURNS_DEFAULT;
  const state = {
    reads: new Set(),
    wrote: false,
    passAfterWrite: false,
    lastModuleText: '',
    lastObservation: options.initialObservation || '(no observation yet)'
  };
  const receipts = [];
  const turns = [];
  const keys = [];
  const fail = (code, detail) => {
    const err = new LoopError(code, detail);
    err.turns = turns;
    err.receipts = receipts;
    return err;
  };

  if (options.baseline !== false) {
    const baselineAction = { action: 'RUN', target: 'add.test.js', payload: '', reason: 'baseline', done: false };
    const spec = commandFor(baselineAction, fixtureRoot);
    const result = await executeSpec(options.executeHost, spec);
    const obs = observationFromResult('RUN', result);
    receipts.push({ phase: 'baseline', action: baselineAction, spec: { intent: spec.intent, command: spec.command }, observation: obs });
    if (obs.exit_code === 0) {
      throw fail('EXECUTION_FAILED', 'baseline fixture test did not fail');
    }
    state.lastObservation = formatObservation(obs);
  }

  let lastBlocker = null;
  for (let turn = 1; turn <= maxTurns; turn += 1) {
    const idempotencyKey = `${path.basename(fixtureRoot)}-turn-${turn}`;
    if (keys.includes(idempotencyKey)) {
      throw fail('EXECUTION_FAILED', 'duplicate provider key');
    }
    keys.push(idempotencyKey);
    const objective = buildPrompt(state);
    let providerResult;
    try {
      providerResult = await options.invokeProvider({
        run_id: `run:${idempotencyKey}`,
        objective,
        reasoning_type: 'PLAN',
        idempotency_key: idempotencyKey,
        source_refs: [],
        context_budget: { max_tokens: 512, timeout_ms: 90000 }
      });
    } catch (err) {
      const code = err && err.code;
      if (code === 'CHATGPT_HUMAN_CHALLENGE') {
        throw fail('CHATGPT_HUMAN_CHALLENGE', 'human verification is visible');
      }
      throw fail('PROVIDER_UNAVAILABLE', code || (err && err.message) || 'provider call failed');
    }
    const content = providerResult && providerResult.candidate_content;
    turns.push({
      turn,
      idempotency_key: idempotencyKey,
      provider: providerResult && providerResult.provider,
      surface: providerResult && providerResult.surface,
      state: providerResult && providerResult.state,
      disposition: providerResult && providerResult.disposition,
      content: String(content || '').slice(0, 2000)
    });

    let action;
    try {
      action = parseProviderAction(content);
      if (action.action === 'APPLY_PATCH' && state.lastModuleText) {
        const patch = JSON.parse(action.payload);
        action = { ...action, _next: state.lastModuleText.replace(patch.find, patch.replace) };
      }
      validateAction(action, state);
    } catch (err) {
      const failure = err instanceof LoopError ? err : new LoopError('PROVIDER_OUTPUT_INVALID', err.message);
      lastBlocker = failure.code;
      turns[turns.length - 1].typed_failure = failure.code;
      turns[turns.length - 1].typed_detail = failure.message;
      state.lastObservation = `${failure.code}: ${failure.message}`;
      if (turn === maxTurns) {
        throw fail(lastBlocker === 'DONE_WITHOUT_PASS' ? 'DONE_WITHOUT_PASS' : 'LOOP_LIMIT_REACHED', failure.message);
      }
      continue;
    }

    if (action.action === 'DONE') {
      return {
        pass: true,
        fixtureRoot,
        turns,
        receipts,
        provider_turns: turns.length,
        deterministic_steps: receipts.length
      };
    }

    if (action.action === 'READ_OUTPUT') {
      const obs = {
        action: 'READ_OUTPUT',
        executor: 'DETERMINISTIC_HOST',
        status: 'SUCCESS',
        exit_code: 0,
        output: state.lastObservation,
        stderr: ''
      };
      receipts.push({ phase: 'action', action, observation: obs });
      state.lastObservation = formatObservation(obs);
      continue;
    }

    const moduleText = action._next || action.payload;
    const spec = commandFor(action, fixtureRoot, moduleText);
    let result;
    try {
      result = await executeSpec(options.executeHost, spec);
    } catch (err) {
      lastBlocker = err instanceof LoopError ? err.code : 'EXECUTION_FAILED';
      state.lastObservation = `${lastBlocker}: ${err.message}`;
      turns[turns.length - 1].typed_failure = lastBlocker;
      if (turn === maxTurns) {
        const wrapped = err instanceof LoopError ? err : new LoopError('EXECUTION_FAILED', err.message);
        wrapped.turns = turns;
        wrapped.receipts = receipts;
        throw wrapped;
      }
      continue;
    }
    const obs = observationFromResult(action.action, result);
    try {
      noteSuccess(state, action, obs, spec);
    } catch (err) {
      lastBlocker = err.code;
      state.lastObservation = `${err.code}: ${err.message}`;
      if (turn === maxTurns) {
        err.turns = turns;
        err.receipts = receipts;
        throw err;
      }
      continue;
    }
    receipts.push({
      phase: 'action',
      action: { action: action.action, target: action.target, reason: action.reason },
      spec: { intent: spec.intent, effect_class: spec.effect_class, command: spec.command },
      observation: obs
    });
    state.lastObservation = formatObservation(obs);
  }

  throw fail('LOOP_LIMIT_REACHED', lastBlocker || 'turn ceiling reached before DONE');
}

module.exports = {
  ACTIONS,
  LoopError,
  parseProviderAction,
  validateAction,
  canonicalizeModule,
  moduleOperator,
  runSelfDevelopmentLoop,
  MAX_TURNS_DEFAULT
};
