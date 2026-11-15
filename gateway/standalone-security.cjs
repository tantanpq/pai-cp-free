'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');

const TOKEN_PATTERN = /^[A-Za-z0-9._~+/-]+=*$/;
const PUBLIC_METHODS = new Set(['initialize', 'server/discover', 'tools/list', 'tools/get']);
const PRIVATE_METHODS = new Set(['tools/call', 'tasks/get', 'tasks/update', 'tasks/cancel', 'subscriptions/listen']);
const WRITE_METHODS = new Set(['tasks/update', 'tasks/cancel']);
const CORS_HEADERS = ['authorization', 'content-type', 'mcp-protocol-version', 'mcp-session-id', 'mcp-method', 'mcp-name'];

function list(value, validate, code) {
  if (value === undefined) return null;
  const entries = String(value).split(',').map(s => s.trim());
  if (!entries.length || entries.some(s => !validate(s))) throw new Error(code);
  return new Set(entries);
}

function readBearerToken(env) {
  let token = env.CHIEF_MCP_BEARER_TOKEN;
  if (token !== undefined && env.CHIEF_MCP_BEARER_TOKEN_FILE !== undefined) throw new Error('CHIEF_MCP_TOKEN_SOURCE_AMBIGUOUS');
  if (env.CHIEF_MCP_BEARER_TOKEN_FILE !== undefined) {
    try {
      const fileStat = fs.lstatSync(env.CHIEF_MCP_BEARER_TOKEN_FILE);
      if (fileStat.isSymbolicLink() || !fileStat.isFile() || (process.platform !== 'win32' && (fileStat.mode & 0o077))) throw new Error('invalid token file');
      const fd = fs.openSync(env.CHIEF_MCP_BEARER_TOKEN_FILE, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > 4098 || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error('invalid token file');
        const buffer = Buffer.alloc(4099);
        const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
        token = buffer.subarray(0, bytes).toString('utf8').replace(/\r?\n$/, '');
      } finally { fs.closeSync(fd); }
    } catch (_) { throw new Error('CHIEF_MCP_TOKEN_FILE_INVALID'); }
  }
  if (token !== undefined && (typeof token !== 'string' || token.length < 32 || token.length > 4096 || !TOKEN_PATTERN.test(token))) {
    throw new Error('CHIEF_MCP_TOKEN_INVALID');
  }
  return token;
}

function securityFromEnv(env, profile) {
  const allowedHosts = list(env.CHIEF_MCP_ALLOWED_HOSTS, value => {
    const match = value.match(/^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[0-9a-f:]+\]):([1-9][0-9]{0,4})$/);
    return match && Number(match[1]) <= 65535;
  }, 'CHIEF_MCP_ALLOWED_HOSTS_INVALID');
  const allowedOrigins = list(env.CHIEF_MCP_ALLOWED_ORIGINS, value => {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && url.origin === value;
    } catch (_) { return false; }
  }, 'CHIEF_MCP_ALLOWED_ORIGINS_INVALID') || new Set();
  const token = readBearerToken(env);
  if (env.CHIEF_MCP_ALLOW_EXEC !== undefined && !['0', '1'].includes(env.CHIEF_MCP_ALLOW_EXEC)) throw new Error('CHIEF_MCP_ALLOW_EXEC_INVALID');
  const allowExec = env.CHIEF_MCP_ALLOW_EXEC === '1';
  if (allowExec && profile === 'READ_ONLY') throw new Error('CHIEF_MCP_EXEC_REQUIRES_WRITE_PROFILE');
  if ((profile !== 'READ_ONLY' || allowExec) && token === undefined) throw new Error('CHIEF_MCP_WRITE_REQUIRES_TOKEN');
  const tokenDigest = token === undefined ? null : crypto.createHash('sha256').update(token).digest();
  return { allowedHosts, allowedOrigins, allowExec, tokenDigest };
}

function normalizeToolName(name) {
  const stripped = typeof name === 'string' ? name.replace(/^(?:pai_terminal|pai-terminal)[.:]/, '') : name;
  return ['chief_work_request', 'pai_terminal', 'terminal', 'pai-terminal', ''].includes(stripped) ? 'pai_action_run' : stripped;
}

function authorized(req, security) {
  const header = req.headers.authorization;
  if (!security.tokenDigest || typeof header !== 'string' || header.length > 4103 || !/^Bearer [A-Za-z0-9._~+/-]+=*$/i.test(header)) return false;
  const digest = crypto.createHash('sha256').update(header.slice(7)).digest();
  return crypto.timingSafeEqual(digest, security.tokenDigest);
}

function checkTransport(req, res, security, boundPort) {
  const uniqueHeader = name => req.rawHeaders.filter((_, i) => i % 2 === 0 && req.rawHeaders[i].toLowerCase() === name).length <= 1;
  const hosts = security.allowedHosts || new Set([`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`]);
  if (!uniqueHeader('host') || typeof req.headers.host !== 'string' || !hosts.has(req.headers.host.toLowerCase())) return 403;
  if (!uniqueHeader('origin') || !uniqueHeader('authorization')) return 403;
  const origin = req.headers.origin;
  res.setHeader('vary', 'Origin');
  if (origin !== undefined) {
    if (!security.allowedOrigins.has(origin)) return 403;
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('access-control-expose-headers', 'mcp-protocol-version, mcp-session-id');
  }
  return null;
}

function preflight(req, res, methods) {
  const method = req.headers['access-control-request-method'];
  const headers = String(req.headers['access-control-request-headers'] || '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
  if (!req.headers.origin || !methods.includes(method) || headers.some(h => !CORS_HEADERS.includes(h))) {
    res.removeHeader('access-control-allow-origin');
    res.removeHeader('access-control-expose-headers');
    return 403;
  }
  res.setHeader('access-control-allow-methods', methods.join(', '));
  res.setHeader('access-control-allow-headers', CORS_HEADERS.join(', '));
  return 204;
}

function checkRpc(req, request, cfg, publicNames) {
  if (!PUBLIC_METHODS.has(request.method) && !PRIVATE_METHODS.has(request.method)) return { code: -32601, message: 'BRIDGE_METHOD_DENIED' };
  if (!PUBLIC_METHODS.has(request.method) && !authorized(req, cfg.security)) return { status: 401, message: 'BEARER_REQUIRED' };
  if (WRITE_METHODS.has(request.method) && cfg.profile === 'READ_ONLY') return { status: 403, message: 'READ_ONLY_PROFILE' };
  if (request.method === 'tools/call' && !publicNames.has(normalizeToolName(request.params?.name))) return { code: -32000, message: 'BRIDGE_TOOL_DENIED' };
  return null;
}

module.exports = { readBearerToken, securityFromEnv, normalizeToolName, checkTransport, preflight, checkRpc };
