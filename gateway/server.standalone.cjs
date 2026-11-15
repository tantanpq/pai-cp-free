'use strict';
/*
 * server.standalone.cjs — Phase-1 standalone composition root for the packaged
 * Chief MCP Gateway.
 *
 * The upstream entry point (chief_chat_bridge_v1/src/server.js) is NOT carried
 * in this package: it hard-requires ten sibling PAI packages and embeds
 * machine-specific defaults (session/user ids, a fixed Drive document catalog,
 * ProgramData runtime paths). This root wires the SAME bridge modules with
 * only the components this package carries:
 *
 *   WIRED FOR REAL
 *   - chief_live_session_v1 (SQLite session store) — chief_resume/chief_status
 *   - computer_execution_fabric_v1 via federation-core — all 6 federation
 *     tools, including pai_action_run (persistent terminal sessions)
 *   - pai-read-gateway owners backed by the canonical-truth adapter and the
 *     real readers (Claim Service / Task Box / current pointer) when the
 *     matching env vars point at live services; otherwise they answer with
 *     the bridge's own BLOCKED codes, exactly like upstream does when an
 *     owner is unavailable.
 *   - delegation admission (GOVERNED_RW / FEDERATION_RW) when a Task Box
 *     root is configured.
 *
 *   STUBBED / NOT WIRED (phase 1 — see README.md "Phase 1 scope")
 *   - PAI Mind gate: stub returning MIND_GATE_NOT_CONFIGURED receipts.
 *     (Upstream lazy-loads pai_mind_v1, which is a phase-2 package.)
 *   - continuity runtime, context gateway (memory rooms), behavioral memory,
 *     prompt-evidence hook, accepted-composition (cognitive lifecycle /
 *     learning / domain intelligence / knowledge room): passed as null; the
 *     bridge treats every one of them as optional and degrades to its own
 *     BLOCKED / not-configured results. Because prompt evidence is not wired,
 *     the prompt tools are removed from the public tool list.
 *   - semantic catalog: empty (upstream catalog lists fixed Drive document
 *     ids of the original deployment; search/fetch therefore return no
 *     semantic entries until an operator supplies their own catalog).
 *
 * Configuration is env-only; no machine-specific value is baked in:
 *   PORT (default 8787) · CHIEF_MCP_PUBLIC_PROFILE (READ_ONLY|GOVERNED_RW|
 *   FEDERATION_RW, default READ_ONLY) · PAI_GATEWAY_DATA (default
 *   ~/.pai-chief-gateway) · CHIEF_BRIDGE_DB_PATH · CHIEF_BRIDGE_SESSION_ID ·
 *   CHIEF_BRIDGE_USER_ID · CHIEF_BRIDGE_PAI_ID · CHIEF_BRIDGE_PROJECT_ID ·
 *   CHIEF_CLAIM_SERVICE_URL · CHIEF_TASK_BOX_ROOT · CHIEF_SYSTEM_CONTROL_PATH ·
 *   PAI_RUNTIME_POINTER · CHIEF_CANONICAL_TRUTH_PATH · CHIEF_QCHECK_PATH ·
 *   CHIEF_MCP_BEARER_TOKEN or CHIEF_MCP_BEARER_TOKEN_FILE ·
 *   CHIEF_MCP_ALLOW_EXEC=1 (write profile only) · CHIEF_MCP_ALLOWED_HOSTS ·
 *   CHIEF_MCP_ALLOWED_ORIGINS (see SECURITY_BOUNDARY.md) ·
 *   PAI_GATEWAY_CANARY=1 (refuses port 8787 and requires an isolated DB path)
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { securityFromEnv, normalizeToolName, checkTransport, preflight, checkRpc } = require('./standalone-security.cjs');

const BRIDGE_SRC = path.join(__dirname, 'chief_chat_bridge_v1', 'src');
const live = require(path.join(__dirname, 'chief_live_session_v1', 'src', 'chief-live-session'));
const bridgeModule = require(path.join(BRIDGE_SRC, 'chief-chat-bridge'));
const { TOOL_DEFINITIONS, PUBLIC_READ_ONLY_TOOL_NAMES, PROMPT_TOOL_NAMES } = bridgeModule;
const { createCanonicalTruthAdapter } = require(path.join(BRIDGE_SRC, 'canonical-truth-adapter'));
const { BOOT_POINTERS, createReadGateway, createCurrentOwnerAdapters, createRealReaders, READ_TOOLS } = require(path.join(BRIDGE_SRC, 'pai-read-gateway'));
const { createAdmission, createBridgeEvidenceReader } = require(path.join(BRIDGE_SRC, 'chief-delegation-admission'));
const { createFederationBridge } = require(path.join(BRIDGE_SRC, 'federation-bridge'));
const federationToolSchemas = require(path.join(BRIDGE_SRC, 'FEDERATION_TOOL_SCHEMAS.json'));

function configFromEnv(env = process.env) {
  const dataRoot = path.resolve(env.PAI_GATEWAY_DATA || path.join(os.homedir(), '.pai-chief-gateway'));
  const dbPath = path.resolve(env.CHIEF_BRIDGE_DB_PATH || path.join(dataRoot, 'state', 'chief-live.sqlite'));
  // Windows paths are case-insensitive: the canary isolation check below
  // must compare case-folded there, or a differently-cased spelling of the
  // production database would slip through.
  const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  if (/Google Drive|My Drive|PAI_PROJECT/i.test(dbPath)) throw new Error('CHIEF_BRIDGE_DB_MUST_BE_LOCAL');
  const canary = env.PAI_GATEWAY_CANARY === '1';
  const port = Number(env.PORT || 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT_INVALID');
  const sessionId = String(env.CHIEF_BRIDGE_SESSION_ID || 'pai-chief-main').trim();
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(sessionId)) throw new Error('CHIEF_BRIDGE_SESSION_ID_INVALID');
  if (canary && port === 8787) throw new Error('CANARY_PORT_MUST_NOT_BE_8787');
  if (canary && (!env.CHIEF_BRIDGE_DB_PATH || samePath(dbPath, path.join(dataRoot, 'state', 'chief-live.sqlite')))) throw new Error('CANARY_DB_MUST_BE_ISOLATED');
  const profile = String(env.CHIEF_MCP_PUBLIC_PROFILE || 'READ_ONLY').toUpperCase();
  if (!['READ_ONLY', 'GOVERNED_RW', 'FEDERATION_RW'].includes(profile)) throw new Error('CHIEF_MCP_PUBLIC_PROFILE_INVALID');
  const security = securityFromEnv(env, profile);
  delete process.env.CHIEF_MCP_BEARER_TOKEN;
  return {
    dbPath, port, canary, sessionId, profile, dataRoot, security,
    claimServiceUrl: env.CHIEF_CLAIM_SERVICE_URL || null,
    taskBoxRoot: env.CHIEF_TASK_BOX_ROOT || null,
    systemControlPath: env.CHIEF_SYSTEM_CONTROL_PATH || null,
    currentPointerPath: env.PAI_RUNTIME_POINTER ? path.resolve(env.PAI_RUNTIME_POINTER) : path.join(dataRoot, 'PAI_RUNTIME', 'CURRENT.json'),
    projectionPath: env.CHIEF_CANONICAL_TRUTH_PATH || null,
    qcheckPath: env.CHIEF_QCHECK_PATH || null,
    identity: {
      userId: env.CHIEF_BRIDGE_USER_ID || 'pai-chief-user',
      paiIdentityId: env.CHIEF_BRIDGE_PAI_ID || 'pai-chief',
      projectId: env.CHIEF_BRIDGE_PROJECT_ID || 'PAI',
      role: 'PAI_CHIEF',
      externalChatId: null,
      externalThreadId: null
    }
  };
}

const mindGateStub = {
  pointerStatus: () => ({ status: 'MIND_GATE_NOT_CONFIGURED', version: null, driveFileId: null, sha256: null, authority: 'POINTER_ONLY_NO_DOCTRINE_CONTENT_LOADED' }),
  ensureDailyRead: () => ({ status: 'MIND_GATE_NOT_CONFIGURED', authority: 'NONE' }),
  preflightMajorWork: () => ({ status: 'MIND_GATE_NOT_CONFIGURED', authority: 'NONE' })
};

function createServer({ env = process.env } = {}) {
  const cfg = configFromEnv(env);
  fs.mkdirSync(path.dirname(cfg.dbPath), { recursive: true });
  const db = live.open(cfg.dbPath);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
  db.exec('CREATE TABLE IF NOT EXISTS chief_bridge_receipts (receipt_key TEXT PRIMARY KEY, input_hash TEXT NOT NULL, body_json TEXT NOT NULL, created_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS chief_action_previews (preview_id TEXT PRIMARY KEY, preview_hash TEXT NOT NULL, expected_revision INTEGER NOT NULL, intent_class TEXT NOT NULL, message_hash TEXT NOT NULL, status TEXT NOT NULL, body_json TEXT NOT NULL, created_at TEXT NOT NULL, committed_at TEXT);');

  const canonicalTruth = createCanonicalTruthAdapter({ projectionPath: cfg.projectionPath, qcheckPath: cfg.qcheckPath, refreshQcheck: null });
  const realReaders = createRealReaders({ claimServiceUrl: cfg.claimServiceUrl, taskBoxRoot: cfg.taskBoxRoot, systemControlPath: cfg.systemControlPath, currentPointerPath: cfg.currentPointerPath });
  const readGateway = createReadGateway({
    owners: createCurrentOwnerAdapters({ continuity: canonicalTruth, contextGateway: null, realReaders, behavioralMemory: null, recentIntent: null, bootPointers: BOOT_POINTERS }),
    catalog: []
  });
  const validTaskBoxRoot = (() => { try { return typeof cfg.taskBoxRoot === 'string' && cfg.taskBoxRoot.trim() && fs.statSync(path.resolve(cfg.taskBoxRoot)).isDirectory() ? cfg.taskBoxRoot : null; } catch (_) { return null; } })();
  const admission = cfg.profile === 'READ_ONLY' ? null : createAdmission({ taskBoxRoot: validTaskBoxRoot, evidenceReader: createBridgeEvidenceReader({ db }) });

  const federationTools = federationToolSchemas.tools;
  let names = cfg.profile === 'READ_ONLY'
    ? PUBLIC_READ_ONLY_TOOL_NAMES
    : [...TOOL_DEFINITIONS, ...READ_TOOLS, ...federationTools].map(x => x.name);
  // Prompt-evidence is not wired in phase 1, so its tools cannot be public
  // (the bridge fails closed if a prompt tool is public without the hook).
  names = names.filter(n => !PROMPT_TOOL_NAMES.has(n));
  // A closed non-execution catalog: new tools need deliberate classification.
  const nonExecNames = new Set([...PUBLIC_READ_ONLY_TOOL_NAMES, ...READ_TOOLS.map(t => t.name),
    'chief_turn', 'chief_prepare_handoff', 'chief_correct_memory', 'chief_admit_committed_work',
    'pai_capabilities', 'pai_run_status', 'pai_result', 'pai_cancel']);
  if (!cfg.security.allowExec) names = names.filter(n => nonExecNames.has(n));
  const publicNames = new Set(names);
  const synchronousSessionTools = new Set(['chief_resume', 'chief_status', 'chief_turn',
    'chief_prepare_handoff', 'chief_correct_memory', 'chief_admit_committed_work']);

  const bridge = createFederationBridge({
    identity: cfg.identity,
    sessionId: cfg.sessionId,
    db,
    continuity: canonicalTruth,
    continuityRuntime: null,
    cognitiveLifecycle: null,
    learningGate: null,
    domainIntelligence: null,
    knowledgeRoom: null,
    contextGateway: null,
    behavioralMemory: null,
    promptEvidence: null,
    mindGate: mindGateStub,
    storage: { mode: 'LOCAL_SQLITE', durable: true, pathHash: crypto.createHash('sha256').update(cfg.dbPath).digest('hex') },
    publicToolNames: names,
    readGateway,
    admission,
    taskBoxRoot: validTaskBoxRoot,
    realReaders,
    refreshQcheck: null
  });

  const server = http.createServer((req, res) => {
    const transportError = checkTransport(req, res, cfg.security, server.address()?.port);
    if (transportError) { res.writeHead(transportError).end(); return; }
    const rawUrl = req.url || '';
    if (!rawUrl.startsWith('/')) { res.writeHead(400).end(); return; }
    const urlPath = rawUrl.split('?')[0].replace(/\/+$/, '') || '/';
    if (urlPath !== '/mcp' && urlPath !== '/health') { res.writeHead(404).end(); return; }
    const methods = urlPath === '/mcp' ? ['POST', 'GET', 'HEAD', 'OPTIONS'] : ['GET', 'HEAD', 'OPTIONS'];
    if (!methods.includes(req.method)) { res.writeHead(405, { allow: methods.join(', ') }).end(); return; }
    if (req.method === 'OPTIONS') {
      res.writeHead(preflight(req, res, methods)).end();
      return;
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && (urlPath === '/mcp' || urlPath === '/health')) {
      const payload = JSON.stringify({
        status: 'READY',
        endpoint: '/mcp',
        protocols: ['2026-07-28', '2025-03-26', '2024-11-05'],
        sessionId: cfg.sessionId,
        profile: cfg.profile,
        composition: 'STANDALONE_PHASE1'
      });
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload)
      });
      if (req.method === 'GET') res.end(payload); else res.end();
      return;
    }

    if (String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
      res.writeHead(415).end();
      return;
    }
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 65536) req.destroy();
    });
    req.on('end', async () => {
      let request;
      try {
        request = JSON.parse(body);
      } catch (_) {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'BRIDGE_PROTOCOL_INVALID' }));
        return;
      }
      if (!request || typeof request !== 'object' || Array.isArray(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'BRIDGE_PROTOCOL_INVALID' }));
        return;
      }
      const denied = checkRpc(req, request, cfg, publicNames);
      if (denied) {
        if (denied.status === 401) res.setHeader('www-authenticate', 'Bearer');
        res.writeHead(denied.status || 200, { 'content-type': 'application/json' }).end(JSON.stringify({
          jsonrpc: '2.0', id: request.id ?? null,
          error: { code: denied.code || -32000, message: denied.message, data: { code: denied.message } }
        }));
        return;
      }

      const protoHeader = req.headers['mcp-protocol-version'];
      if (protoHeader && !['2026-07-28', '2025-03-26', '2024-11-05'].includes(protoHeader)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: request?.id ?? null,
          error: { code: -32600, message: 'PROTOCOL_VERSION_UNSUPPORTED', data: { requested: protoHeader } }
        }));
        return;
      }

      const methodHeader = req.headers['mcp-method'];
      if (methodHeader && methodHeader !== request.method) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: request?.id ?? null,
          error: { code: -32600, message: 'HEADER_METHOD_MISMATCH', data: { header: methodHeader, body: request.method } }
        }));
        return;
      }

      const rawToolName = request.params?.name;
      const normalizedToolName = normalizeToolName(rawToolName);
      const toolNameHeader = req.headers['mcp-name'];
      const normalizedHeaderName = normalizeToolName(toolNameHeader);

      if (toolNameHeader && request.method === 'tools/call') {
        if (toolNameHeader !== rawToolName && normalizedHeaderName !== normalizedToolName) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: request?.id ?? null,
            error: { code: -32600, message: 'HEADER_TOOL_MISMATCH', data: { header: toolNameHeader, body: request.params?.name } }
          }));
          return;
        }
      }

      if (request.method === 'tools/call' && request.params && typeof request.params.name === 'string') {
        request.params.name = normalizedToolName;
      }

      const isLegacy = (protoHeader === '2025-03-26' || protoHeader === '2024-11-05') ||
        (request.method === 'initialize' && request.params?.protocolVersion !== '2026-07-28') ||
        Boolean(req.headers['mcp-session-id']);
      const protocolVersion = (protoHeader === '2024-11-05') ? '2024-11-05' : (isLegacy ? '2025-03-26' : '2026-07-28');

      let response;
      let sessionSavepoint = false;
      try {
        // These existing session tools are synchronous. Undo lazy session
        // creation/audit/receipts on rejection; never span an async RPC await.
        if (request.method === 'tools/call' && synchronousSessionTools.has(request.params?.name)) {
          db.exec('SAVEPOINT standalone_session_call');
          sessionSavepoint = true;
        }
        const rawRes = bridge.rpc(request, { protocolVersion, isLegacy, headers: req.headers });
        if (sessionSavepoint) {
          if (rawRes?.error) db.exec('ROLLBACK TO standalone_session_call');
          db.exec('RELEASE standalone_session_call');
          sessionSavepoint = false;
        }
        response = (rawRes && typeof rawRes.then === 'function') ? await rawRes : rawRes;
      } catch (rpcErr) {
        if (sessionSavepoint) {
          db.exec('ROLLBACK TO standalone_session_call; RELEASE standalone_session_call');
        }
        response = {
          jsonrpc: '2.0',
          id: request?.id ?? null,
          error: {
            code: -32000,
            message: 'CHIEF_BRIDGE_DENIED',
            data: { code: String(rpcErr.message || rpcErr) }
          }
        };
      }

      const resHeaders = {
        'content-type': 'application/json',
        'mcp-protocol-version': (request.method === 'initialize' && response?.result?.protocolVersion)
          ? response.result.protocolVersion
          : protocolVersion
      };
      if (isLegacy) {
        resHeaders['mcp-session-id'] = cfg.sessionId;
      }

      res.writeHead(200, resHeaders);
      res.end(JSON.stringify(response));
    });
  });
  return { server, bridge, db, cfg };
}

if (require.main === module) {
  const app = createServer();
  app.server.listen(app.cfg.port, '127.0.0.1', () => console.log(JSON.stringify({ status: 'READY', endpoint: `http://127.0.0.1:${app.cfg.port}/mcp`, sessionId: app.cfg.sessionId, profile: app.cfg.profile, composition: 'STANDALONE_PHASE1' })));
}

module.exports = { createServer, configFromEnv };
