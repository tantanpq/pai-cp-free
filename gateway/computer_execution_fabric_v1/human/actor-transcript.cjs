'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ACTORS = new Set(['CHATGPT', 'GROK', 'ANTI', 'TAN', 'SYSTEM', 'PTY', 'AGENT', 'HUMAN']);

class ActorTranscript {
  constructor({ rootDir, sessionId, now = () => new Date().toISOString(), maxTextBytes = 64 * 1024 }) {
    this.now = now;
    this.maxTextBytes = maxTextBytes;
    this.file = path.join(rootDir, sessionId, 'transcript.ndjson');
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.seq = 0;
  }

  append({ actor, type, text = null, meta = {} }) {
    actor = String(actor || '').toUpperCase();
    if (!ACTORS.has(actor)) throw new Error('TRANSCRIPT_ACTOR_INVALID');
    if (!type || typeof type !== 'string') throw new Error('TRANSCRIPT_TYPE_INVALID');
    if (text != null && Buffer.byteLength(String(text), 'utf8') > this.maxTextBytes) throw new Error('TRANSCRIPT_TEXT_TOO_LARGE');
    const row = { seq: ++this.seq, at: this.now(), actor, type, ...(text == null ? {} : { text: String(text) }), meta };
    fs.appendFileSync(this.file, `${JSON.stringify(row)}\n`, 'utf8');
    return row;
  }

  secretMarker(meta = {}) { return this.append({ actor: 'SYSTEM', type: 'secret_input_completed', meta }); }
}

module.exports = { ActorTranscript, ACTORS };
