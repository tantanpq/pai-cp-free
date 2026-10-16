// actions-rea/registry.mjs — REA Control Plane action registry.
// rea-cp là BUILD-TIME map tool (KHÔNG phải runtime service plane).
//   map.scan — quét 1 URL qua REA inspect-web-page (CDP) → JSON evidence.
//   map.diff — đối chiếu selector chain với map JSON → VERIFIED/NEEDS-CHANGE/NOT-FOUND.
// Hard exclusions: không rewrite config agent, không anti-bot/CAPTCHA evasion,
// không paid action trên target, không đụng ngoài CDP page được chỉ định.
// Retry phẳng tối đa 2 attempt. Mọi action đều sinh evidence.
// B1: bootstrap site cho browser-control-plane-core (KHÔNG đổi behavior).
// LƯU Ý: preferUrl 'chatgpt.com' giữ nguyên behavior bản cũ (copy-paste artifact —
// bản cũ đọc nhầm CHATGPT_CP_PREFER_URL); không ảnh hưởng prod vì worker không set env này.
import { configureSite } from '../../browser-control-plane-core/site.mjs';
import { cdpUrl as _siteCdpUrl, deployDir as _siteDeployDir, evidenceDir as _siteEvidenceDir } from '../config.mjs';
configureSite({ prefix: 'REA_CP', cdpUrl: _siteCdpUrl, deployDir: _siteDeployDir, evidenceDir: _siteEvidenceDir, preferUrl: 'chatgpt.com' });
import { cdpEndpoint, reaBin } from '../config.mjs';
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ok = (data = {}) => ({ ok: true, data });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function evidenceDir() {
  return process.env.REA_CP_EVIDENCE_DIR || 'C:\\temp\\rea-cp\\evidence';
}
async function evidence(ctx, step, data = {}) {
  try { await ctx.ev?.logStep?.(step, { timestamp: new Date().toISOString(), ...data }); } catch { /* Evidence không chặn action. */ }
}
async function withRetry(fn, label) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return await fn(attempt); } catch (error) {
      if (attempt === 1) throw new Error(label, { cause: error });
    }
  }
}
async function shot(ctx, label) {
  const p = await withRetry(() => ctx.prim.shot(ctx.page, label), 'SCREENSHOT_FAILED');
  await evidence(ctx, label, { path: p });
  return p;
}

// Chạy REA CLI trên MSI. MSI: npx.cmd (không phải npx.ps1 — execution policy).
// Output JSON đọc từ stdout (KHÔNG dùng PowerShell `>` — nó ghi UTF-16).
// Node execFile KHÔNG spawn được .cmd trực tiếp (EINVAL) → đi qua cmd.exe /c.
function reaCli(args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const child = execFile('cmd.exe', ['/d', '/s', '/c', 'npx.cmd', '-y', 'rea-agents@latest', ...args], {
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`rea cli failed: ${String(error.message).slice(0, 300)} | stderr: ${String(stderr).slice(0, 300)}`));
      resolve(String(stdout));
    });
    child.on('error', reject);
  });
}
function tryParseJson(text) {
  const t = String(text).trim();
  try { return JSON.parse(t); } catch { /* thử bóc JSON trong output */ }
  const m = t.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* bỏ */ } }
  throw new Error('REA_CLI_NON_JSON_OUTPUT');
}
function mapStats(map) {
  const nr = map?.normalized_result || {};
  const nodes = nr?.accessibility?.nodes || [];
  return {
    url: nr?.target?.url || nr?.target?.title || null,
    accessibilityNodes: nodes.length,
    domNodes: nr?.dom?.total_nodes ?? null,
    limitations: (nr?.limitations || []).slice(0, 6),
  };
}

export const actions = {
  // Quét 1 URL: mở trên CDP page → tìm targetId → inspect-web-page → JSON evidence.
  // Read-only: không click, không điền, không submit.
  'map.scan': async (ctx, { url, observationMs = 3000, outName } = {}) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw new Error('MAP_SCAN_BAD_URL');
    const obs = Math.min(Math.max(Number(observationMs) || 3000, 500), 30000);
    await shot(ctx, 'map.scan-before');
    await withRetry(() => ctx.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }), 'MAP_SCAN_NAV_FAILED');
    await pause(obs);
    await evidence(ctx, 'map.scan.navigated', { url, observationMs: obs });
    await shot(ctx, 'map.scan-landed');

    // 1. Lấy targetId CHÍNH XÁC của page mình điều khiển (không đoán từ list):
    // stale/background tab làm inspect-web-page treo — bài học 2026-10-11.
    const cdpSession = await withRetry(() => ctx.page.context().newCDPSession(ctx.page), 'MAP_SCAN_CDP_SESSION_FAILED');
    const { targetInfo } = await withRetry(() => cdpSession.send('Target.getTargetInfo'), 'MAP_SCAN_TARGET_INFO_FAILED');
    const targetId = targetInfo?.targetId;
    if (!targetId) throw new Error('MAP_SCAN_NO_TARGET_ID');
    await evidence(ctx, 'map.scan.target', { targetId, url });

    // 2. inspect-web-page → JSON.
    const scanRaw = await withRetry(() => reaCli([
      'inspect-web-page', cdpEndpoint, targetId,
      '--observation-ms', String(obs),
      '--include-accessibility-text',
      '--format', 'json',
    ], 180000), 'MAP_SCAN_INSPECT_FAILED');
    const map = tryParseJson(scanRaw);
    const stats = mapStats(map);

    // 3. Lưu map JSON vào evidence dir (UTF-8, không qua PowerShell redirect).
    const dir = evidenceDir();
    const safe = String(outName || 'map').replace(/[^a-zA-Z0-9-_]/g, '-').slice(0, 40) || 'map';
    const file = path.join(dir, `${Date.now()}-${safe}.json`);
    writeFileSync(file, JSON.stringify(map), 'utf8');
    await evidence(ctx, 'map.scan.saved', { file, ...stats });
    await shot(ctx, 'map.scan-after');
    try { await ctx.page.close(); } catch { /* dọn tab sau scan */ }
    await evidence(ctx, 'map.scan.closed');
    return ok({ file, target: { targetId, url }, stats, command: `inspect-web-page ${cdpEndpoint} ${targetId} --observation-ms ${obs}` });
  },

  // Đối chiếu selector chain với map JSON: VERIFIED / NEEDS-CHANGE / NOT-FOUND.
  // checks: [{ id, role?, name?, namePattern? }] — namePattern là regex string.
  'map.diff': async (ctx, { mapFile, checks } = {}) => {
    if (typeof mapFile !== 'string' || !mapFile.trim()) throw new Error('MAP_DIFF_BAD_MAP_FILE');
    if (!Array.isArray(checks) || !checks.length) throw new Error('MAP_DIFF_NO_CHECKS');
    const map = JSON.parse(await readFile(mapFile, 'utf8'));
    const nodes = map?.normalized_result?.accessibility?.nodes || [];
    const results = checks.map((c) => {
      const roleRe = c.role ? new RegExp(`^${c.role}$`, 'i') : null;
      const nameRe = c.namePattern ? new RegExp(c.namePattern, 'i')
        : (c.name ? new RegExp(`^${c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') : null);
      const roleHits = nodes.filter((n) => !n.ignored && roleRe && roleRe.test(String(n.role || '')));
      const fullHits = roleHits.filter((n) => !nameRe || nameRe.test(String(n.name || '')));
      const sample = (arr) => arr.slice(0, 3).map((n) => ({ node_id: n.node_id, role: n.role, name: n.name }));
      if (fullHits.length) return { id: c.id, verdict: 'VERIFIED', hits: fullHits.length, sample: sample(fullHits) };
      if (roleHits.length) {
        const names = [...new Set(roleHits.map((n) => String(n.name || '')).filter(Boolean))].slice(0, 10);
        return { id: c.id, verdict: 'NEEDS-CHANGE', hits: 0, roleHits: roleHits.length, candidateNames: names };
      }
      return { id: c.id, verdict: 'NOT-FOUND', hits: 0 };
    });
    const summary = {
      verified: results.filter((r) => r.verdict === 'VERIFIED').length,
      needsChange: results.filter((r) => r.verdict === 'NEEDS-CHANGE').length,
      notFound: results.filter((r) => r.verdict === 'NOT-FOUND').length,
    };
    const dir = evidenceDir();
    const file = path.join(dir, `${Date.now()}-diff.json`);
    writeFileSync(file, JSON.stringify({ mapFile, results, summary }, null, 2), 'utf8');
    await evidence(ctx, 'map.diff', { file, summary });
    return ok({ file, summary, results });
  },
};
