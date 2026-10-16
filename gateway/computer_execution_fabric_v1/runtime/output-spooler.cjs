'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_RING_BYTES = 256 * 1024;
const DEFAULT_MAX_SPOOL_BYTES = 8 * 1024 * 1024;

function trimIncompleteUtf8Tail(buf) {
  const len = buf.length;
  if (len === 0) return buf;

  const b0 = buf[len - 1];
  // 1-byte ASCII (0x00..0x7F) or valid continuation (0x80..0xBF)
  if ((b0 & 0x80) === 0) return buf;

  // Check 1 byte from end
  if (b0 >= 0xC0 && b0 <= 0xDF) {
    // 2-byte sequence missing 1 continuation byte
    return buf.subarray(0, len - 1);
  }
  if (b0 >= 0xE0 && b0 <= 0xEF) {
    // 3-byte sequence missing 2 continuation bytes
    return buf.subarray(0, len - 1);
  }
  if (b0 >= 0xF0 && b0 <= 0xF7) {
    // 4-byte sequence missing 3 continuation bytes
    return buf.subarray(0, len - 1);
  }

  // Check 2 bytes from end
  if (len >= 2) {
    const b1 = buf[len - 2];
    if (b1 >= 0xE0 && b1 <= 0xEF) {
      // 3-byte sequence missing 1 continuation byte
      return buf.subarray(0, len - 2);
    }
    if (b1 >= 0xF0 && b1 <= 0xF7) {
      // 4-byte sequence missing 2 continuation bytes
      return buf.subarray(0, len - 2);
    }
  }

  // Check 3 bytes from end
  if (len >= 3) {
    const b2 = buf[len - 3];
    if (b2 >= 0xF0 && b2 <= 0xF7) {
      // 4-byte sequence missing 1 continuation byte
      return buf.subarray(0, len - 3);
    }
  }

  return buf;
}

function createOutputSpooler(options = {}) {
  const ringBytes = Number.isInteger(options.ringBytes) ? options.ringBytes : DEFAULT_RING_BYTES;
  const maxSpoolBytes = Number.isInteger(options.maxSpoolBytes) ? options.maxSpoolBytes : DEFAULT_MAX_SPOOL_BYTES;
  const spoolPath = options.spoolPath;
  if (!spoolPath || typeof spoolPath !== 'string') {
    throw new Error('SPOOL_PATH_REQUIRED');
  }

  const sessionId = options.sessionId || null;
  const opaqueOutputRef = options.outputRef || (sessionId
    ? `pai-terminal-output://${sessionId}`
    : `pai-terminal-output://default`);

  fs.mkdirSync(path.dirname(spoolPath), { recursive: true });
  fs.writeFileSync(spoolPath, Buffer.alloc(0));

  let totalBytes = 0;
  let truncatedSpool = false;
  const ring = [];
  let ringSize = 0;

  function append(chunk) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    if (!buf.length) return { totalBytes, truncatedSpool };
    if (totalBytes >= maxSpoolBytes) {
      truncatedSpool = true;
      return { totalBytes, truncatedSpool };
    }
    const remain = maxSpoolBytes - totalBytes;
    const written = buf.length > remain ? buf.subarray(0, remain) : buf;
    if (written.length < buf.length) truncatedSpool = true;
    fs.appendFileSync(spoolPath, written);
    totalBytes += written.length;
    ring.push(written);
    ringSize += written.length;
    while (ringSize > ringBytes && ring.length) {
      const dropped = ring.shift();
      ringSize -= dropped.length;
    }
    return { totalBytes, truncatedSpool };
  }

  function read({ cursor = 0, maxBytes = 4096, maxLines = 80, tail = false } = {}) {
    const admitted = totalBytes;
    const capBytes = Math.max(0, Number(maxBytes) || 0);
    const capLines = Math.max(1, Number(maxLines) || 1);

    let start = Number.isInteger(cursor) && cursor >= 0 ? cursor : 0;
    if (start > admitted) start = admitted;

    if (tail === true) {
      start = Math.max(0, admitted - capBytes);
    }

    let length = Math.min(capBytes, Math.max(0, admitted - start));
    let slice = Buffer.alloc(0);

    if (length > 0) {
      const fd = fs.openSync(spoolPath, 'r');
      try {
        // If tail started on a UTF-8 continuation byte, advance start to a valid boundary
        if (tail === true && start > 0) {
          const leadCheck = Buffer.alloc(Math.min(4, admitted - start));
          const leadRead = fs.readSync(fd, leadCheck, 0, leadCheck.length, start);
          let offset = 0;
          while (offset < leadRead && (leadCheck[offset] & 0xC0) === 0x80) {
            offset++;
          }
          start += offset;
          length = Math.min(capBytes, Math.max(0, admitted - start));
        }

        if (length > 0) {
          slice = Buffer.alloc(length);
          const n = fs.readSync(fd, slice, 0, length, start);
          slice = slice.subarray(0, n);
        }
      } finally {
        fs.closeSync(fd);
      }
    }

    // Protect against slicing in the middle of a multi-byte UTF-8 sequence at the end
    if (start + slice.length < admitted) {
      slice = trimIncompleteUtf8Tail(slice);
    }

    // Apply maxLines on raw bytes without text-to-buffer re-encoding
    if (slice.length > 0 && capLines > 0) {
      if (tail === true) {
        // For tail, take up to capLines from the end of slice
        let linesCount = 0;
        let cutStart = 0;
        for (let i = slice.length - 1; i >= 0; i--) {
          if (slice[i] === 0x0A) {
            linesCount++;
            if (linesCount > capLines) {
              cutStart = i + 1;
              break;
            }
          }
        }
        if (cutStart > 0) {
          start += cutStart;
          slice = slice.subarray(cutStart);
        }
      } else {
        let linesCount = 0;
        let cutIndex = slice.length;
        for (let i = 0; i < slice.length; i++) {
          if (slice[i] === 0x0A) { // newline
            linesCount++;
            if (linesCount >= capLines) {
              cutIndex = i + 1;
              break;
            }
          }
        }
        if (cutIndex < slice.length) {
          slice = slice.subarray(0, cutIndex);
        }
      }
    }

    const nextCursor = start + slice.length;
    const text = slice.toString('utf8');
    const truncated = nextCursor < admitted || truncatedSpool;

    return {
      text,
      bytes: slice.length,
      cursor: start,
      nextCursor,
      truncated,
      admitted_bytes: admitted,
      truncated_spool: truncatedSpool,
      output_ref: opaqueOutputRef,
      tail: tail === true
    };
  }

  return {
    append,
    read,
    get output_ref() { return opaqueOutputRef; },
    get spoolPath() { return spoolPath; },
    get admitted_bytes() { return totalBytes; },
    get truncated_spool() { return truncatedSpool; },
    get ring_bytes() { return ringSize; }
  };
}

const safeSession = value => {
  const text = String(value || '');
  if (!/^[A-Za-z0-9._-]{6,160}$/.test(text)) throw new Error('SPOOL_SESSION_ID_INVALID');
  return text;
};

class OutputSpooler {
  constructor({ rootDir, sessionId, now = () => new Date().toISOString() }) {
    if (!rootDir) throw new Error('SPOOL_ROOT_REQUIRED');
    this.sessionId = safeSession(sessionId);
    this.now = now;
    this.dir = path.join(rootDir, this.sessionId);
    fs.mkdirSync(this.dir, { recursive: true });
    this.paths = {
      combined: path.join(this.dir, 'output.log'),
      stdout: path.join(this.dir, 'stdout.log'),
      stderr: path.join(this.dir, 'stderr.log'),
      index: path.join(this.dir, 'output-index.ndjson')
    };
    this.combinedBytes = fs.existsSync(this.paths.combined) ? fs.statSync(this.paths.combined).size : 0;
    this.streamBytes = {
      stdout: fs.existsSync(this.paths.stdout) ? fs.statSync(this.paths.stdout).size : 0,
      stderr: fs.existsSync(this.paths.stderr) ? fs.statSync(this.paths.stderr).size : 0
    };
    this.seq = 0;
  }

  append(stream, value, meta = {}) {
    if (!['stdout', 'stderr', 'system'].includes(stream)) throw new Error('SPOOL_STREAM_INVALID');
    const data = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
    const combinedStart = this.combinedBytes;
    fs.appendFileSync(this.paths.combined, data);
    this.combinedBytes += data.length;
    let streamStart = null;
    if (stream === 'stdout' || stream === 'stderr') {
      streamStart = this.streamBytes[stream];
      fs.appendFileSync(this.paths[stream], data);
      this.streamBytes[stream] += data.length;
    }
    const event = {
      seq: ++this.seq,
      at: this.now(),
      stream,
      bytes: data.length,
      combinedStart,
      combinedEnd: this.combinedBytes,
      streamStart,
      streamEnd: streamStart == null ? null : streamStart + data.length,
      ...meta
    };
    fs.appendFileSync(this.paths.index, `${JSON.stringify(event)}\n`, 'utf8');
    return event;
  }

  readCombined(start = 0, maxBytes = 64 * 1024) {
    if (!Number.isInteger(start) || start < 0 || !Number.isInteger(maxBytes) || maxBytes < 1) throw new Error('SPOOL_RANGE_INVALID');
    const size = this.combinedBytes;
    const position = Math.min(start, size);
    const length = Math.min(maxBytes, size - position);
    const buffer = Buffer.alloc(length);
    if (length) {
      const fd = fs.openSync(this.paths.combined, 'r');
      try { fs.readSync(fd, buffer, 0, length, position); } finally { fs.closeSync(fd); }
    }
    return { data: buffer, start: position, next: position + length, end: size, hasMore: position + length < size };
  }

  outputRef({ start = 0, end = this.combinedBytes } = {}) {
    return `pai-output://${encodeURIComponent(this.sessionId)}/combined?start=${start}&end=${end}`;
  }

  snapshot() {
    return { combinedBytes: this.combinedBytes, streamBytes: { ...this.streamBytes }, outputRef: this.outputRef(), paths: { ...this.paths } };
  }
}

module.exports = {
  OutputSpooler,
  createOutputSpooler,
  DEFAULT_RING_BYTES,
  DEFAULT_MAX_SPOOL_BYTES,
  trimIncompleteUtf8Tail
};
