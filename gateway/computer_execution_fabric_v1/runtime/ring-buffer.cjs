'use strict';

class ByteRingBuffer {
  constructor(maxBytes = 256 * 1024) {
    if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error('RING_MAX_BYTES_INVALID');
    this.maxBytes = maxBytes;
    this.chunks = [];
    this.startCursor = 0;
    this.endCursor = 0;
  }

  append(value) {
    const buffer = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(String(value), 'utf8');
    if (!buffer.length) return { start: this.endCursor, end: this.endCursor };
    const start = this.endCursor;
    const end = start + buffer.length;
    this.endCursor = end;
    this.chunks.push({ start, end, buffer });
    this.#trim();
    return { start, end };
  }

  #trim() {
    const keepFrom = Math.max(0, this.endCursor - this.maxBytes);
    while (this.chunks.length && this.chunks[0].end <= keepFrom) this.chunks.shift();
    if (this.chunks.length && this.chunks[0].start < keepFrom) {
      const first = this.chunks[0];
      const offset = keepFrom - first.start;
      this.chunks[0] = { start: keepFrom, end: first.end, buffer: first.buffer.subarray(offset) };
    }
    this.startCursor = this.chunks.length ? this.chunks[0].start : this.endCursor;
  }

  read(cursor = this.startCursor, maxBytes = this.maxBytes) {
    if (!Number.isInteger(cursor) || cursor < 0) throw new Error('RING_CURSOR_INVALID');
    if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error('RING_READ_BYTES_INVALID');
    const requestedCursor = cursor;
    let truncated = false;
    if (cursor < this.startCursor) {
      cursor = this.startCursor;
      truncated = true;
    }
    if (cursor > this.endCursor) cursor = this.endCursor;
    let remaining = maxBytes;
    const parts = [];
    let nextCursor = cursor;
    for (const chunk of this.chunks) {
      if (remaining <= 0 || chunk.end <= nextCursor) continue;
      const offset = Math.max(0, nextCursor - chunk.start);
      const take = Math.min(remaining, chunk.buffer.length - offset);
      if (take <= 0) continue;
      parts.push(chunk.buffer.subarray(offset, offset + take));
      nextCursor += take;
      remaining -= take;
    }
    return {
      requestedCursor,
      retainedStartCursor: this.startCursor,
      endCursor: this.endCursor,
      nextCursor,
      truncated,
      hasMore: nextCursor < this.endCursor,
      data: Buffer.concat(parts)
    };
  }

  tail(maxBytes = Math.min(this.maxBytes, 8192)) {
    if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error('RING_TAIL_BYTES_INVALID');
    return this.read(Math.max(this.startCursor, this.endCursor - maxBytes), maxBytes);
  }

  snapshot() {
    return { maxBytes: this.maxBytes, startCursor: this.startCursor, endCursor: this.endCursor, retainedBytes: this.endCursor - this.startCursor };
  }
}

module.exports = { ByteRingBuffer };
