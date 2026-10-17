// Vendored from the house Assurance toolkit src/treeid.mjs SECRET_PATTERN,
// vendored 2026-10-16 so CI can run it on a public runner.
// The canonical scanner remains the Assurance toolkit.
import fs from 'node:fs';
import path from 'node:path';
import { root, readJSON, relative, walk } from './common.mjs';

// Inspect syntax only. Matched values are never retained, copied, or reported.
export function secretPattern(bytes) {
  const text = bytes.toString('utf8');
  const privateKey = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/u;
  const assignment = /\b(?:(?:aws_)?secret_access_key|aws_access_key_id|(?:[a-z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|secret|password|client[_-]?secret|secret[_-]?key))["']?\s*[=:]\s*["']?\S+/iu;
  if (privateKey.test(text) || assignment.test(text)) return true;
  // Normalize escaped JSON field names before inspecting key syntax; never return a value.
  const keyPattern = /^(?:(?:aws_)?secret_access_key|aws_access_key_id|(?:[a-z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|secret|password|client[_-]?secret|secret[_-]?key))$/iu;
  function inspect(value) {
    if (!value || typeof value !== 'object') return typeof value === 'string' && (assignment.test(value) || privateKey.test(value));
    return Object.entries(value).some(([key, item]) => keyPattern.test(key) && item !== '' && item !== null || inspect(item));
  }
  try { return inspect(JSON.parse(text)); } catch { return false; }
}

try {
  const allowlist = readJSON(path.join(root, 'tools/ci/scan-allowlist.json'));
  if (!Array.isArray(allowlist) || allowlist.some((entry) =>
    typeof entry.path !== 'string' || !entry.path || typeof entry.reason !== 'string' || !entry.reason.trim())) {
    throw new Error('Invalid secret scan allowlist');
  }
  let count = 0;
  let findings = 0;
  let binary = 0;
  for (const file of walk(root, allowlist.map((entry) => entry.path))) {
    const bytes = fs.readFileSync(file);
    if (bytes.includes(0)) { binary++; continue; }
    count++;
    if (secretPattern(bytes)) {
      console.log('SECRET_PATTERN ' + relative(file));
      findings++;
    }
  }
  console.log((findings ? 'FAIL' : 'PASS') + ' SECRET_SCAN files=' + count + ' binary_skipped=' + binary + ' findings=' + findings);
  process.exitCode = findings ? 1 : 0;
} catch {
  // Even parse errors can include source bytes: never echo scanner input.
  console.error('FAIL SECRET_SCAN unable to read repository or allowlist');
  process.exitCode = 1;
}
