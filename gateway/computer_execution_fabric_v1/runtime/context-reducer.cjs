'use strict';

class ContextReducer {
  constructor({ visibleTailBytes = 8192, summarizer = null } = {}) {
    this.visibleTailBytes = visibleTailBytes;
    this.summarizer = summarizer;
  }

  async reduce({ sessionId, state, exitCode = null, spool, ring }) {
    const tail = ring.tail(this.visibleTailBytes);
    const text = tail.data.toString('utf8');
    const summary = typeof this.summarizer === 'function'
      ? await this.summarizer({ sessionId, state, text, outputBytes: spool.combinedBytes })
      : null;
    return {
      sessionId,
      state,
      exitCode,
      outputBytes: spool.combinedBytes,
      visibleTailBytes: tail.data.length,
      visibleTail: text,
      truncatedInMemory: ring.startCursor > 0,
      outputRef: spool.outputRef(),
      summary
    };
  }
}

module.exports = { ContextReducer };
