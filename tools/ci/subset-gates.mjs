import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { root, readJSON, relative, under, walk, localPath } from './common.mjs';

// Keep EXCLUDE in sync with PACKAGE_MANIFEST.md's PUBLIC SUBSET.
const excluded = ['core/chatgpt-cp', 'core/grok-cp', 'core/suno-cp', 'addons', 'docs', 'TIERS.md', 'PRICING_DRAFT_INTERNAL.md'];
let passed = 0;
let failed = 0;
function check(ok, label) {
  console.log((ok ? 'PASS ' : 'FAIL ') + label);
  if (ok) passed++; else failed++;
}

try {
  for (const prefix of excluded) {
    // lstat also notices dangling symlinks: an excluded path must not exist.
    let exists = true;
    try { fs.lstatSync(path.join(root, prefix)); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      exists = false;
    }
    check(!exists, 'EXCLUDE ' + prefix);
  }
  const license = fs.existsSync(path.join(root, 'LICENSE')) ? fs.readFileSync(path.join(root, 'LICENSE'), 'utf8') : '';
  check(license.includes('PolyForm Shield License 1.0.0') && license.includes('Required Notice: Copyright 2026 Tan Ho'), 'LICENSE');
  const manifest = fs.readFileSync(path.join(root, 'PACKAGE_MANIFEST.md'), 'utf8');
  const section = manifest.split(/^### PUBLIC SUBSET\r?$/m)[1]?.split(/^#{1,3} /m)[0] || '';
  check(section.includes('.claude-plugin/') && section.includes('plugins/') &&
    section.includes('**Marketplace addendum (2026-10-16):**'), 'MANIFEST RECORDED');
  const exceptions = readJSON(path.join(root, 'tools/ci/manifest-hash-exceptions.json'));
  const exceptionMap = new Map(exceptions.map((entry) => {
    if (!entry.path || !entry.reason) throw new Error('Invalid manifest hash exception');
    return [entry.path, entry.reason];
  }));
  const rows = [...manifest.matchAll(/^\|\s*`([^`]+)`\s*\|\s*`([^`]*)`\s*\|/gm)];
  check(rows.length > 0, 'MANIFEST HASHES rows=' + rows.length);
  let checked = 0;
  let skipped = 0;
  let absent = 0;
  for (const [, ref, hex] of rows) {
    if (!/^[a-f0-9]{64}$/iu.test(hex)) {
      check(false, 'MANIFEST HASHES ' + ref + ' invalid SHA-256 (expected 64 hex characters)');
      continue;
    }
    const file = localPath(root, ref);
    if (!fs.existsSync(file)) {
      const allowed = excluded.some((prefix) => under(ref, prefix));
      check(allowed, 'MANIFEST HASHES ' + ref + (allowed ? ' absent (EXCLUDE)' : ' missing'));
      absent++;
    } else if (exceptionMap.has(ref)) {
      console.log('SKIP MANIFEST HASHES ' + ref + ': ' + exceptionMap.get(ref));
      skipped++;
    } else {
      const digest = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      check(digest === hex.toLowerCase(), 'MANIFEST HASHES ' + ref);
      checked++;
    }
  }
  console.log('MANIFEST HASHES checked=' + checked + ' skipped=' + skipped + ' absent=' + absent);
  const pointers = readJSON(path.join(root, 'tools/ci/pointer-allowlist.json')).map((entry) => {
    if (!entry.file || !entry.pattern || !entry.reason) throw new Error('Invalid pointer allowlist');
    return { ...entry, regex: new RegExp(entry.pattern, 'u') };
  });
  let files = 0;
  let hits = 0;
  let allowed = 0;
  for (const file of walk()) {
    const bytes = fs.readFileSync(file);
    if (bytes.includes(0)) continue;
    files++;
    const ref = relative(file);
    const lines = bytes.toString('utf8').split(/\r?\n/u);
    for (let i = 0; i < lines.length; i++) {
      for (const _hit of lines[i].matchAll(/tantanpq\/pai-cp(?!-free)/g)) {
        hits++;
        if (pointers.some((entry) => entry.file === ref && entry.regex.test(lines[i]))) allowed++;
        else check(false, 'POINTERS ' + ref + ':' + (i + 1) + ' ' + lines[i]);
      }
    }
  }
  check(hits === allowed, 'POINTERS files=' + files + ' hits=' + hits + ' allowlisted=' + allowed);
} catch (error) {
  check(false, 'SUBSET ' + error.message);
}
console.log((failed ? 'FAIL' : 'PASS') + ' SUBSET_GATES passed=' + passed + ' failed=' + failed);
process.exitCode = failed ? 1 : 0;
