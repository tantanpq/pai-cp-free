'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SECRET_KEYS = /password|secret|token_value|authorization|cookie|credential|private_key/i;
const redact = value => {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = SECRET_KEYS.test(key) ? '[REDACTED]' : redact(item);
  return out;
};

class ReceiptWriter {
  constructor({ rootDir, sessionId, now = () => new Date().toISOString() }) {
    this.dir = path.join(rootDir, sessionId, 'receipts');
    fs.mkdirSync(this.dir, { recursive: true });
    this.sessionId = sessionId;
    this.now = now;
  }

  write(input) {
    const semanticStatus = input.semanticStatus || 'UNRESOLVED';
    if (!['UNRESOLVED', 'VERIFIED_EXTERNALLY', 'FAILED_EXTERNALLY'].includes(semanticStatus)) throw new Error('RECEIPT_SEMANTIC_STATUS_INVALID');
    const receiptId = input.receiptId || `rcpt-${crypto.randomUUID()}`;
    const body = redact({
      receiptVersion: 'pai-execution-receipt/r1',
      receiptId,
      sessionId: this.sessionId,
      at: this.now(),
      commandStatus: input.commandStatus || 'UNKNOWN',
      semanticStatus,
      ...input
    });
    const target = path.join(this.dir, `${receiptId}.json`);
    fs.writeFileSync(target, `${JSON.stringify(body, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    return { ...body, receiptPath: target };
  }

  get(receiptId) {
    if (!/^[A-Za-z0-9._-]{6,200}$/.test(String(receiptId || ''))) throw new Error('RECEIPT_ID_INVALID');
    const target = path.join(this.dir, `${receiptId}.json`);
    if (!fs.existsSync(target)) return null;
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  }

  list() {
    return fs.readdirSync(this.dir).filter(name => name.endsWith('.json')).sort().map(name => this.get(name.slice(0, -5)));
  }
}

module.exports = { ReceiptWriter, redact };
