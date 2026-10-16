'use strict';

const crypto = require('node:crypto');

class SecretInputChannel {
  constructor({ transcript = null, maxBytes = 16 * 1024, now = () => new Date().toISOString() } = {}) {
    this.transcript = transcript;
    this.maxBytes = maxBytes;
    this.now = now;
    this.pending = new Map();
  }

  request({ sessionId, purpose = 'SECRET_INPUT', expiresMs = 120000 } = {}) {
    if (!sessionId) throw new Error('SECRET_SESSION_REQUIRED');
    const token = `sec-${crypto.randomUUID()}`;
    const record = { token, sessionId, purpose, createdAt: this.now(), expiresAtMs: Date.now() + expiresMs };
    this.pending.set(token, record);
    this.transcript?.append({ actor: 'SYSTEM', type: 'secret_input_required', meta: { sessionId, purpose } });
    return { token, sessionId, purpose, expiresAtMs: record.expiresAtMs };
  }

  async submit({ token, secret, writer }) {
    const record = this.pending.get(token);
    if (!record) throw new Error('SECRET_TOKEN_INVALID');
    if (Date.now() > record.expiresAtMs) { this.pending.delete(token); throw new Error('SECRET_TOKEN_EXPIRED'); }
    if (typeof writer !== 'function') throw new Error('SECRET_WRITER_REQUIRED');
    const buffer = Buffer.isBuffer(secret) ? Buffer.from(secret) : Buffer.from(String(secret), 'utf8');
    if (!buffer.length || buffer.length > this.maxBytes) throw new Error('SECRET_SIZE_INVALID');
    try {
      await writer(buffer);
      this.pending.delete(token);
      this.transcript?.secretMarker({ sessionId: record.sessionId, purpose: record.purpose });
      return { completed: true, sessionId: record.sessionId, purpose: record.purpose };
    } finally {
      buffer.fill(0);
    }
  }

  cancel(token) { return this.pending.delete(token); }
}

module.exports = { SecretInputChannel };
