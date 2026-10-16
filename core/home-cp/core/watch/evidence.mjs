// evidence.mjs — browser-control-plane-core (shared).
// Canonical source duy nhất cho 5 site CP (gộp từ bản ChatGPT CP).
// Evidence root = site().evidenceDir — site cấu hình qua configureSite() trong site.mjs.
// Contract giữ nguyên: beginRun, logStep, endRun.
import fs from 'node:fs';
import path from 'node:path';
import { site } from '../site.mjs';

const root = () => site().evidenceDir;

function stringifySafe(value) {
  const ancestors = [];

  return JSON.stringify(value, function (key, item) {
    if (typeof item === 'bigint') return item.toString();
    if (typeof item === 'undefined') return null;
    if (typeof item === 'function' || typeof item === 'symbol') {
      return String(item);
    }
    if (item instanceof Error) {
      return {
        name: item.name,
        message: item.message,
        stack: item.stack,
      };
    }
    if (item !== null && typeof item === 'object') {
      while (ancestors.length && ancestors.at(-1) !== this) {
        ancestors.pop();
      }
      if (ancestors.includes(item)) return '[Circular]';
      ancestors.push(item);
    }
    return item;
  }, 2);
}

function runDirectory(runId) {
  if (
    typeof runId !== 'string' ||
    !/^\d{8}-\d{6}-[a-zA-Z0-9_.-]*-[0-9a-f]{4}$/.test(runId)
  ) {
    throw new Error(`Invalid runId: ${String(runId)}`);
  }
  return path.join(root(), runId);
}

function fail(operation, runId, error) {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${operation} failed for runId ${runId}: ${message}`);
}

export function beginRun(actionName) {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  const timestamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const action = String(actionName);
  const sanitized = action.replace(/[^a-zA-Z0-9_.-]/g, '-') || 'run';
  const rand4 = Math.floor(Math.random() * 0x10000)
    .toString(16)
    .padStart(4, '0');
  const runId = `${timestamp}-${sanitized}-${rand4}`;

  try {
    const dir = runDirectory(runId);
    fs.mkdirSync(dir, { recursive: true });
    process.env[`${site().prefix}_EVIDENCE_DIR`] = dir;
    fs.writeFileSync(
      path.join(dir, 'run.json'),
      stringifySafe({
        actionName: action,
        runId,
        startedAt: now.toISOString(),
      }) + '\n',
      'utf8',
    );
    return { runId, dir };
  } catch (error) {
    throw fail('beginRun', runId, error);
  }
}

export function logStep(runId, step, data) {
  try {
    const entry = {
      t: new Date().toISOString(),
      step,
      data,
    };
    // Keep each record on one physical line.
    const line = JSON.stringify(JSON.parse(stringifySafe(entry)));
    fs.appendFileSync(
      path.join(runDirectory(runId), 'steps.jsonl'),
      line + '\n',
      'utf8',
    );
  } catch (error) {
    throw fail('logStep', runId, error);
  }
}

export function endRun(runId, result) {
  try {
    const ok = Boolean(result?.ok);
    const normalized = {
      ok,
      ...(ok
        ? { data: result?.data ?? null }
        : { error: result?.error ?? 'Unknown error' }),
      endedAt: new Date().toISOString(),
    };
    const serialized = stringifySafe(normalized);
    fs.writeFileSync(
      path.join(runDirectory(runId), 'result.json'),
      serialized + '\n',
      'utf8',
    );
    return JSON.parse(serialized);
  } catch (error) {
    throw fail('endRun', runId, error);
  }
}
