'use strict';

const crypto = require('node:crypto');

const OPERATIONS = new Set(['SESSION_OPEN','SESSION_INPUT','SESSION_READ','SESSION_STATUS','SESSION_SNAPSHOT','SESSION_RESIZE','SESSION_CLOSE','SESSION_TAKEOVER','SESSION_RELEASE','SECRET_INPUT_REQUEST','OUTPUT_READ','RECEIPT_GET']);
const NEVER_SECRET_FIELDS = /password|secret|credential|cookie|authorization|private.?key/i;

const validatePayload = value => {
  if (value == null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('HOST_CONTROL_PAYLOAD_INVALID');
  const walk = node => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    const out = {};
    for (const [key, item] of Object.entries(node)) {
      if (NEVER_SECRET_FIELDS.test(key)) throw new Error('HOST_CONTROL_SECRET_FIELD_DENIED');
      out[key] = walk(item);
    }
    return out;
  };
  return walk(value);
};

function buildHostControlWorkSpec(input) {
  if (!input || typeof input !== 'object') throw new Error('HOST_CONTROL_INPUT_INVALID');
  const operation = String(input.operation || '').toUpperCase();
  if (!OPERATIONS.has(operation)) throw new Error('HOST_CONTROL_OPERATION_INVALID');
  const requestId = String(input.requestId || '').trim();
  const rootId = String(input.rootId || '').trim();
  const mutableScope = String(input.mutableScope || 'NONE').trim();
  const effectClass = String(input.effectClass || '').trim();
  if (!requestId || !rootId || !effectClass) throw new Error('HOST_CONTROL_IDENTITY_REQUIRED');
  const payload = validatePayload(input.payload);
  const packet = {
    profile: 'PAI_GOVERNED_HOST_CONTROL_R1',
    contract: 'PERSISTENT_SESSION_R1',
    operation,
    requestId,
    rootId,
    sessionId: input.sessionId || null,
    ownerHostHint: input.ownerHostHint || null,
    shellClass: input.shellClass || null,
    effectClass,
    payload
  };
  const task = `PAI_HOST_CONTROL_PACKET_R1\n${JSON.stringify(packet)}`;
  if (task.length > 2000) throw new Error('HOST_CONTROL_WORKSPEC_TOO_LARGE');
  const requiredCapabilities = [...new Set([
    'GOVERNED_HOST_CONTROL',
    'PERSISTENT_INTERACTIVE_SESSION',
    ...(Array.isArray(input.requiredCapabilities) ? input.requiredCapabilities : [])
  ])];
  if (requiredCapabilities.some(cap => /CODEX|GROK|ANTIGRAVITY|SHELL_RAW/i.test(cap))) throw new Error('HOST_CONTROL_PROVIDER_OR_RAW_SHELL_CAPABILITY_DENIED');
  return {
    mutableScope,
    requiredCapabilities,
    priority: input.priority || 'P1',
    rootId,
    parentId: input.parentId || rootId,
    workdir: input.workdir || mutableScope,
    dataMode: input.dataMode || (mutableScope === 'NONE' ? 'READ_ONLY' : 'READ_WRITE'),
    task,
    packetDigest: crypto.createHash('sha256').update(task).digest('hex')
  };
}

module.exports = { buildHostControlWorkSpec, OPERATIONS };
