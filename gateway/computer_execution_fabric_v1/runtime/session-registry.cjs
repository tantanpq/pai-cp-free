'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const stable = value => Array.isArray(value) ? `[${value.map(stable).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}` : JSON.stringify(value);
const hash = value => crypto.createHash('sha256').update(stable(value)).digest('hex');
const safeId = value => {
  const text = String(value || '');
  if (!/^[A-Za-z0-9._-]{6,160}$/.test(text)) throw new Error('SESSION_ID_INVALID');
  return text;
};

class SessionRegistry {
  constructor(rootDir) {
    if (!rootDir) throw new Error('SESSION_REGISTRY_ROOT_REQUIRED');
    this.rootDir = rootDir;
    this.dir = path.join(rootDir, 'registry');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  file(sessionId) { return path.join(this.dir, `${safeId(sessionId)}.json`); }

  save(metadata) {
    if (!metadata || typeof metadata !== 'object') throw new Error('SESSION_METADATA_INVALID');
    const sessionId = safeId(metadata.sessionId);
    const body = { ...metadata, metadataHash: undefined };
    delete body.metadataHash;
    const stored = { ...body, metadataHash: hash(body) };
    const target = this.file(sessionId);
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(stored, null, 2)}\n`, 'utf8');
    fs.renameSync(temp, target);
    return stored;
  }

  get(sessionId) {
    const target = this.file(sessionId);
    if (!fs.existsSync(target)) return null;
    const stored = JSON.parse(fs.readFileSync(target, 'utf8'));
    const copy = { ...stored };
    const claimed = copy.metadataHash;
    delete copy.metadataHash;
    if (hash(copy) !== claimed) throw new Error('SESSION_METADATA_HASH_MISMATCH');
    return stored;
  }

  list() {
    return fs.readdirSync(this.dir).filter(name => name.endsWith('.json')).map(name => this.get(name.slice(0, -5))).filter(Boolean);
  }

  findByOpenKey(openIdempotencyKey) {
    if (!openIdempotencyKey) return null;
    return this.list().find(item => item.openIdempotencyKey === openIdempotencyKey) || null;
  }

  markRestartOrphans(now = new Date().toISOString()) {
    const changed = [];
    for (const metadata of this.list()) {
      if (!['OPEN', 'ACTIVE', 'RUNNING', 'WAITING_INPUT', 'IDLE', 'RECOVERING'].includes(metadata.state)) continue;
      const next = this.save({ ...metadata, state: 'ORPHANED', orphanedAt: now, lastActivityAt: now });
      changed.push(next);
    }
    return changed;
  }
}

module.exports = { SessionRegistry, stable, hash };
