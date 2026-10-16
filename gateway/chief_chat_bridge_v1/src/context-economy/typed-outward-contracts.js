'use strict';

/**
 * Typed Outward Contracts for PAI Context Economy
 * 
 * Enforces typed outward contracts on the wire:
 * 1. CONTROL_RECEIPT: bounded receipt <= 1 KB preferred, <= 1.8 KB hard ceiling.
 * 2. TERMINAL_READ_CHUNK: raw terminal output up to 4 KB AND <= 40 lines.
 *    next_cursor MUST strictly match the delivered visible chunk bytes without blind clipping.
 * 3. EXACT_FETCH_CHUNK: bounded content fetch up to 8 KB preferred, 12 KB hard ceiling + cursor/pointer.
 * 4. HEAVY_ACTION_RESULT: receipt <= 1.8 KB, raw logs staged externally with reference.
 */

const { reduceToolResult } = require('./tool-result-reducer');

const OUTWARD_CONTRACT_TYPES = Object.freeze({
  CONTROL_RECEIPT: 'CONTROL_RECEIPT',
  TERMINAL_READ_CHUNK: 'TERMINAL_READ_CHUNK',
  EXACT_FETCH_CHUNK: 'EXACT_FETCH_CHUNK',
  HEAVY_ACTION_RESULT: 'HEAVY_ACTION_RESULT'
});

const OUTWARD_BUDGETS = Object.freeze({
  CONTROL_RECEIPT: { preferredBytes: 1024, maxBytes: 1843 },
  TERMINAL_READ_CHUNK: { maxBytes: 4096, maxLines: 40 },
  EXACT_FETCH_CHUNK: { preferredBytes: 8192, maxBytes: 12288 },
  HEAVY_ACTION_RESULT: { maxBytes: 1843 }
});

function trimIncompleteUtf8(buf) {
  let len = buf.length;
  if (len === 0) return buf;

  while (len > 0 && (buf[len - 1] & 0xC0) === 0x80) {
    len--;
  }
  if (len > 0) {
    const lastByte = buf[len - 1];
    if ((lastByte & 0xE0) === 0xC0 && (buf.length - len + 1) < 2) {
      return buf.subarray(0, len - 1);
    }
    if ((lastByte & 0xF0) === 0xE0 && (buf.length - len + 1) < 3) {
      return buf.subarray(0, len - 1);
    }
    if ((lastByte & 0xF8) === 0xF0 && (buf.length - len + 1) < 4) {
      return buf.subarray(0, len - 1);
    }
  }
  return buf;
}

function formatTypedOutwardResult({ toolName, input = {}, result = {} } = {}) {
  if (!result || typeof result !== 'object') {
    return result;
  }

  const rawOp = String(
    input.operation ||
    input.action_payload?.operation ||
    result.operation ||
    result.terminal_operation ||
    ''
  ).toUpperCase().trim();

  // 1. TERMINAL_READ_CHUNK
  // When an explicit terminal READ is performed:
  // - Raw terminal output up to 4 KB AND <= 40 lines.
  // - next_cursor MUST strictly match the delivered/visible chunk bytes!
  // - Do NOT blindly truncate or clip read chunks into a 1.8 KB generic receipt.
  const isTerminalRead = (
    (toolName === 'pai_action_run' || toolName === 'chief_work_request' || toolName === 'read') && (
      rawOp === 'READ' ||
      (result.terminal_session && result.terminal_session.text !== undefined && result.terminal_session.cursor !== undefined) ||
      (result.text !== undefined && (result.cursor !== undefined || result.next_cursor !== undefined || result.nextCursor !== undefined))
    )
  );

  if (isTerminalRead) {
    const term = result.terminal_session || result;
    const rawText = term.text !== undefined ? String(term.text) : '';
    const cursor = Number.isInteger(term.cursor) ? term.cursor : (Number(term.cursor) || 0);

    let buf = Buffer.from(rawText, 'utf8');

    // Bound to maxBytes (4096)
    if (buf.length > OUTWARD_BUDGETS.TERMINAL_READ_CHUNK.maxBytes) {
      buf = buf.subarray(0, OUTWARD_BUDGETS.TERMINAL_READ_CHUNK.maxBytes);
      buf = trimIncompleteUtf8(buf);
    }

    // Bound to maxLines (40)
    let lines = 0;
    let cutIdx = buf.length;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0x0A) {
        lines++;
        if (lines >= OUTWARD_BUDGETS.TERMINAL_READ_CHUNK.maxLines) {
          cutIdx = i + 1;
          break;
        }
      }
    }
    if (cutIdx < buf.length) {
      buf = buf.subarray(0, cutIdx);
    }

    const deliveredText = buf.toString('utf8');
    const deliveredBytes = buf.length;

    // CRUCIAL: next_cursor strictly matches delivered visible chunk bytes
    const nextCursor = cursor + deliveredBytes;
    const totalBytes = Number(
      term.total_bytes !== undefined ? term.total_bytes :
      (term.admitted_bytes !== undefined ? term.admitted_bytes :
      (result.total_bytes !== undefined ? result.total_bytes :
      (result.admitted_bytes !== undefined ? result.admitted_bytes : nextCursor)))
    );
    const hasMore = nextCursor < totalBytes;

    return {
      contract_type: OUTWARD_CONTRACT_TYPES.TERMINAL_READ_CHUNK,
      ...result,
      session_id: term.session_id || input.session_id || result.session_id || null,
      cursor,
      next_cursor: nextCursor,
      nextCursor,
      bytes: deliveredBytes,
      visible_bytes: deliveredBytes,
      total_bytes: totalBytes,
      has_more: hasMore,
      text: deliveredText,
      truncated: Boolean(term.truncated || hasMore),
      output_ref: term.output_ref || result.output_ref || null,
      status: result.status || 'COMPLETED',
      lifecycle_state: result.lifecycle_state || 'COMPLETED',
      request_id: result.request_id || input.request_id || null
    };
  }

  // 2. EXACT_FETCH_CHUNK
  // Bounded content fetch up to 8 KB preferred, 12 KB hard ceiling + cursor/pointer
  if (toolName === 'fetch' || (result.metadata && result.metadata.pointerOnly !== undefined)) {
    const serialized = JSON.stringify(result);
    if (Buffer.byteLength(serialized, 'utf8') > OUTWARD_BUDGETS.EXACT_FETCH_CHUNK.maxBytes) {
      const text = typeof result.text === 'string' ? result.text : JSON.stringify(result);
      let boundedBuf = Buffer.from(text, 'utf8').subarray(0, OUTWARD_BUDGETS.EXACT_FETCH_CHUNK.preferredBytes);
      boundedBuf = trimIncompleteUtf8(boundedBuf);
      return {
        contract_type: OUTWARD_CONTRACT_TYPES.EXACT_FETCH_CHUNK,
        ...result,
        text: boundedBuf.toString('utf8'),
        bytes: boundedBuf.length,
        truncated: true,
        pointer: result.id || result.canonicalId || (result.metadata && result.metadata.fullRef) || null
      };
    }
    return {
      contract_type: OUTWARD_CONTRACT_TYPES.EXACT_FETCH_CHUNK,
      ...result
    };
  }

  // 3. CONTROL_RECEIPT (explicit terminal control: OPEN, STATUS, SNAPSHOT, CLOSE)
  const isTerminalControl = (
    (toolName === 'pai_action_run' || toolName === 'chief_work_request') &&
    ['OPEN', 'STATUS', 'SNAPSHOT', 'CLOSE'].includes(rawOp)
  );

  if (isTerminalControl) {
    const term = result.terminal_session || result;
    return {
      contract_type: OUTWARD_CONTRACT_TYPES.CONTROL_RECEIPT,
      ...result,
      request_id: result.request_id || input.request_id || null,
      operation: rawOp,
      session_id: term.session_id || input.session_id || result.session_id || null,
      status: result.status || term.status || 'PASS',
      lifecycle_state: result.lifecycle_state || 'COMPLETED',
      state: term.state || result.state || null,
      cursor: term.cursor ?? result.cursor ?? null,
      next_cursor: term.next_cursor ?? term.nextCursor ?? result.next_cursor ?? result.nextCursor ?? null,
      nextCursor: term.next_cursor ?? term.nextCursor ?? result.next_cursor ?? result.nextCursor ?? null,
      output_ref: term.output_ref || result.output_ref || null,
      pid: term.pid || result.pid || null,
      reason: result.reason || term.reason || null
    };
  }

  // 4. HEAVY_ACTION_RESULT vs small CONTROL_RECEIPT
  const serialized = JSON.stringify(result);
  const serializedBytes = Buffer.byteLength(serialized, 'utf8');

  if (serializedBytes > OUTWARD_BUDGETS.HEAVY_ACTION_RESULT.maxBytes) {
    const reducedReceipt = reduceToolResult({
      operation: input.intent || input.operation || rawOp || 'HEAVY_ACTION',
      sourceProvider: result.transport || result.selected_executor_if_assigned || 'PAI_HOST_CONTROL',
      scope: input.scope || 'DEFAULT_SCOPE',
      keyFindings: [result.reason || result.status || result.blocker?.detail || 'Execution completed'],
      disposition: result.status || (result.lifecycle_state === 'COMPLETED' ? 'PASS' : 'FAIL'),
      evidenceRefs: [
        result.result_ref ||
        result.output_ref ||
        (result.receipt && result.receipt.evidence_pointer) ||
        `request:${result.request_id || input.request_id}`
      ]
    }, { maxBytes: OUTWARD_BUDGETS.HEAVY_ACTION_RESULT.maxBytes });

    return {
      contract_type: OUTWARD_CONTRACT_TYPES.HEAVY_ACTION_RESULT,
      request_id: result.request_id || input.request_id || null,
      status: result.status || (result.lifecycle_state === 'COMPLETED' ? 'PASS' : 'FAIL'),
      lifecycle_state: result.lifecycle_state || 'COMPLETED',
      receipt: reducedReceipt,
      raw_logs_external: true,
      output_ref: result.output_ref || (result.terminal_session && result.terminal_session.output_ref) || null
    };
  }

  // Default: result <= 1.8 KB is a CONTROL_RECEIPT
  return {
    contract_type: OUTWARD_CONTRACT_TYPES.CONTROL_RECEIPT,
    ...result
  };
}

module.exports = {
  OUTWARD_CONTRACT_TYPES,
  OUTWARD_BUDGETS,
  formatTypedOutwardResult
};
