'use strict';

const { PtyAdapter } = require('../../runtime/pty-adapter.cjs');

class FakePersistentAdapter extends PtyAdapter {
  constructor(options = {}) {
    super(options);
    this.cwd = options.cwd || '/tmp';
    this.env = { ...(options.env || {}) };
    this.replCounter = 0;
    this.pid = options.pid || 4242;
    this.received = [];
  }
  async start() { this.started = true; return this.status(); }
  status() { return { ...super.status(), pid: this.pid, implementation: 'FAKE_TEST_ADAPTER' }; }
  async snapshot() { return { ...this.status(), cwd: this.cwd, envKeys: Object.keys(this.env).sort(), replCounter: this.replCounter }; }
  out(text, stream = 'stdout') { this.emit('data', { stream, data: Buffer.from(String(text), 'utf8') }); }
  async write(data) {
    if (this.closed) throw new Error('FAKE_CLOSED');
    const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    this.received.push(text);
    const commands = text.split(/\r?\n/).map(v => v.trim()).filter(Boolean);
    for (const command of commands) {
      if (command === 'pwd') this.out(`${this.cwd}\n`);
      else if (command.startsWith('cd ')) { this.cwd = command.slice(3).trim(); this.out(`cwd=${this.cwd}\n`); }
      else if (command.startsWith('setenv ')) {
        const pair = command.slice(7); const i = pair.indexOf('=');
        if (i < 1) this.out('bad-env\n', 'stderr'); else { this.env[pair.slice(0, i)] = pair.slice(i + 1); this.out('env-set\n'); }
      } else if (command.startsWith('getenv ')) this.out(`${this.env[command.slice(7).trim()] ?? ''}\n`);
      else if (command === 'repl start') { this.replCounter = 0; this.out('repl-ready\n'); }
      else if (command.startsWith('repl ')) { this.replCounter += 1; this.out(`repl#${this.replCounter}:${command.slice(5)}\n`); }
      else if (command.startsWith('spam ')) this.out('x'.repeat(Number(command.slice(5)) || 0));
      else if (command === 'stderr') this.out('synthetic-error\n', 'stderr');
      else if (command === 'exit') { this.closed = true; this.emit('exit', { code: 0, signal: null }); }
      else this.out(`ok:${command}\n`);
    }
    if (!this.closed) this.emit('state', { state: 'WAITING_INPUT' });
    return { bytes: Buffer.byteLength(text) };
  }
  async resize(cols, rows) { return { supported: true, cols, rows }; }
  async close({ force = false } = {}) { if (this.closed) return { closed: true, idempotent: true }; this.closed = true; return { closed: true, force }; }
}

module.exports = { FakePersistentAdapter };
