'use strict';

const { EventEmitter } = require('node:events');

class PtyAdapter extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.started = false;
    this.closed = false;
  }
  async start() { throw new Error('PTY_START_NOT_IMPLEMENTED'); }
  async write(_data) { throw new Error('PTY_WRITE_NOT_IMPLEMENTED'); }
  async resize(_cols, _rows) { return { supported: false }; }
  async snapshot() { return this.status(); }
  async close(_options = {}) { throw new Error('PTY_CLOSE_NOT_IMPLEMENTED'); }
  status() { return { started: this.started, closed: this.closed }; }
}

module.exports = { PtyAdapter };
