'use strict';

/**
 * Tool-Result Reducer
 * 
 * Sits between heavy external/tool work and conversational context.
 * Transforms raw outputs into bounded, structured receipts, ensuring full
 * logs and evidence stay external while conversational context remains bounded.
 */

const crypto = require('node:crypto');

const sha256 = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

const DEFAULT_MAX_RECEIPT_BYTES = 1800; // ~450 tokens max for standard receipts
const MAX_CHANGED_FILES = 12;
const MAX_KEY_FINDINGS = 6;
const MAX_MATERIAL_DELTAS = 6;
const MAX_EVIDENCE_REFS = 6;

// Connector limit constants
const CONNECTOR_LIMITS = Object.freeze({
  DRIVE: { maxRows: 8, metadataOnly: true },
  GITHUB: { maxFiles: 10, maxDiffLinesPerFile: 15, summaryOnly: true },
  GMAIL: { maxMessages: 5, headerOnly: true },
  MCP: { maxBytes: 12288 },
  WEB_RESEARCH: { maxSources: 5, maxFindingsChars: 1200 }
});

/**
 * Reduce arbitrary tool/subagent execution output to a bounded receipt.
 * 
 * @param {object} input
 * @param {string} input.operation - e.g. 'BUILD', 'TEST', 'QA_VERIFY', 'FILE_EDIT', 'SUBAGENT_RESEARCH'
 * @param {string} input.sourceProvider - e.g. 'ANTIGRAVITY_CLI', 'GROK_CLI', 'DRIVE', 'GITHUB', 'MCP'
 * @param {string} [input.scope] - Target workspace/file scope
 * @param {string|string[]} [input.keyFindings] - Summary observations
 * @param {string|string[]} [input.materialDeltas] - Only what materially changed
 * @param {string[]|object[]} [input.changedFiles] - Changed paths or objects
 * @param {object|string} [input.tests] - Test status (e.g. { passed: 22, failed: 0, skipped: 0, status: 'PASS' })
 * @param {string} [input.disposition] - 'PASS', 'FAIL', 'BLOCKED', 'DONE', 'NO_MATERIAL_DELTA'
 * @param {string|string[]} [input.evidenceRefs] - Pointers to external logs/artifacts
 * @param {string} [input.blocker] - Blocker description if any
 * @param {string} [input.next] - Next eligible action
 * @param {object} [input.error] - If failed, essential diagnostic error fields
 * @param {object} [options]
 * @returns {object} Bounded receipt adhering to Section 10 contract
 */
function reduceToolResult(input = {}, options = {}) {
  if (!input || typeof input !== 'object') {
    throw new Error('REDUCER_INPUT_INVALID');
  }

  const operation = String(input.operation || 'OPERATION').toUpperCase().trim();
  const sourceProvider = String(input.sourceProvider || input.source_provider || 'SYSTEM').trim();
  const scope = input.scope ? String(input.scope).trim() : 'DEFAULT_SCOPE';

  // Format key findings
  let keyFindings = [];
  if (Array.isArray(input.keyFindings || input.key_findings)) {
    keyFindings = (input.keyFindings || input.key_findings).slice(0, MAX_KEY_FINDINGS).map(f => String(f).trim());
  } else if (input.keyFindings || input.key_findings) {
    keyFindings = [String(input.keyFindings || input.key_findings).trim()];
  }

  // Format material deltas
  let materialDeltas = [];
  if (Array.isArray(input.materialDeltas || input.material_deltas)) {
    materialDeltas = (input.materialDeltas || input.material_deltas).slice(0, MAX_MATERIAL_DELTAS).map(d => String(d).trim());
  } else if (input.materialDeltas || input.material_deltas) {
    materialDeltas = [String(input.materialDeltas || input.material_deltas).trim()];
  }

  // Format changed files
  let changedFiles = [];
  const rawFiles = input.changedFiles || input.changed_files;
  if (Array.isArray(rawFiles)) {
    changedFiles = rawFiles.slice(0, MAX_CHANGED_FILES).map(f => {
      if (typeof f === 'string') return f.trim();
      return f?.path || f?.file || JSON.stringify(f);
    });
  } else if (rawFiles) {
    changedFiles = [String(rawFiles).trim()];
  }

  // Format tests
  let tests = null;
  if (input.tests) {
    if (typeof input.tests === 'object') {
      tests = {
        status: input.tests.status || (input.tests.failed > 0 ? 'FAIL' : 'PASS'),
        total: input.tests.total ?? (Number(input.tests.passed || 0) + Number(input.tests.failed || 0) + Number(input.tests.skipped || 0)),
        passed: input.tests.passed ?? null,
        failed: input.tests.failed ?? 0,
        skipped: input.tests.skipped ?? 0
      };
    } else {
      tests = String(input.tests).trim();
    }
  }

  // Format disposition
  const disposition = String(input.disposition || (input.error ? 'FAIL' : 'PASS')).toUpperCase().trim();

  // Format evidence refs
  let evidenceRefs = [];
  const rawRefs = input.evidenceRefs || input.evidence_refs;
  if (Array.isArray(rawRefs)) {
    evidenceRefs = rawRefs.slice(0, MAX_EVIDENCE_REFS).map(r => String(r).trim());
  } else if (rawRefs) {
    evidenceRefs = [String(rawRefs).trim()];
  }

  // Format blocker & next
  const blocker = input.blocker ? String(input.blocker).trim() : null;
  const next = input.next ? String(input.next).trim() : null;

  // Error diagnosability (Section 38): Do not overtruncate to "ERROR"
  let errorDetail = null;
  if (input.error) {
    const err = input.error;
    errorDetail = {
      error_class: err.errorClass || err.name || 'UNKNOWN_ERROR',
      owner: err.owner || sourceProvider,
      attempt_id: err.attemptId || err.attempt_id || null,
      essential_lines: Array.isArray(err.essentialLines)
        ? err.essentialLines.slice(0, 5)
        : (err.message ? [String(err.message).slice(0, 300)] : ['UNKNOWN_FAILURE']),
      evidence_pointer: err.evidencePointer || err.logPath || (evidenceRefs[0] || 'external:log')
    };
  }

  const receipt = {
    schema: 'pai-tool-result-receipt/v1',
    operation,
    source_provider: sourceProvider,
    scope,
    key_findings: keyFindings,
    material_deltas: materialDeltas,
    changed_files: changedFiles,
    tests,
    disposition,
    evidence_refs: evidenceRefs,
    blocker,
    next,
    ...(errorDetail ? { error: errorDetail } : {})
  };

  // Check and bound byte size
  const serialized = JSON.stringify(receipt);
  const maxBytes = options.maxBytes || DEFAULT_MAX_RECEIPT_BYTES;
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    receipt.truncated = true;
    if (receipt.key_findings.length > 2) receipt.key_findings = receipt.key_findings.slice(0, 2);
    if (receipt.material_deltas.length > 2) receipt.material_deltas = receipt.material_deltas.slice(0, 2);
    if (receipt.changed_files.length > 3) {
      receipt.changed_files = [...receipt.changed_files.slice(0, 3), `...and ${changedFiles.length - 3} more`];
    }
    receipt.evidence_refs = evidenceRefs.slice(0, 2);
  }

  receipt.receipt_hash = sha256(JSON.stringify(receipt));
  return Object.freeze(receipt);
}

/**
 * Reducer for external connector payloads (Section 11, 12).
 */
function reduceConnectorOutput(connectorType, rawData, options = {}) {
  const normType = String(connectorType || '').toUpperCase().trim();

  switch (normType) {
    case 'DRIVE': {
      // Drive: metadata only, bounded rows (max 8)
      const rows = Array.isArray(rawData) ? rawData : (rawData?.items || rawData?.results || []);
      const maxRows = options.maxRows || CONNECTOR_LIMITS.DRIVE.maxRows;
      const bounded = rows.slice(0, maxRows).map(row => ({
        id: row.id || row.driveId || row.name,
        name: row.name || row.title,
        mimeType: row.mimeType || 'application/vnd.google-apps.unknown',
        modifiedTime: row.modifiedTime || null,
        size: row.size || null
      }));
      return {
        connector: 'DRIVE',
        total_found: rows.length,
        returned_count: bounded.length,
        has_more: rows.length > maxRows,
        metadata_only: true,
        items: bounded
      };
    }

    case 'GITHUB': {
      // GitHub: exact repo/issue/PR/diff fields only; full diffs stay external
      const files = Array.isArray(rawData?.files) ? rawData.files : [];
      const maxFiles = options.maxFiles || CONNECTOR_LIMITS.GITHUB.maxFiles;
      const fileSummaries = files.slice(0, maxFiles).map(f => ({
        filename: f.filename || f.path,
        status: f.status || 'modified',
        additions: f.additions || 0,
        deletions: f.deletions || 0,
        patch_summary: f.patch ? `${f.patch.split('\n').length} lines diff` : 'external'
      }));
      return {
        connector: 'GITHUB',
        repo: rawData?.repository || rawData?.repo || null,
        commit_or_pr: rawData?.sha || rawData?.prNumber || null,
        files_changed_count: files.length,
        returned_files: fileSummaries,
        raw_diff_external: true
      };
    }

    case 'GMAIL': {
      // Gmail: bounded thread/message fields
      const messages = Array.isArray(rawData) ? rawData : (rawData?.messages || []);
      const maxMsgs = options.maxMessages || CONNECTOR_LIMITS.GMAIL.maxMessages;
      const headers = messages.slice(0, maxMsgs).map(m => ({
        id: m.id,
        threadId: m.threadId,
        from: m.from || m.sender,
        subject: (m.subject || '').slice(0, 120),
        date: m.date || null
      }));
      return {
        connector: 'GMAIL',
        total_messages: messages.length,
        returned_headers: headers,
        full_body_external: true
      };
    }

    case 'WEB_RESEARCH': {
      // Web research: source list + synthesized findings
      const sources = Array.isArray(rawData?.sources) ? rawData.sources : [];
      const findings = Array.isArray(rawData?.findings) ? rawData.findings : [rawData?.summary || ''];
      const maxSources = options.maxSources || CONNECTOR_LIMITS.WEB_RESEARCH.maxSources;
      return {
        connector: 'WEB_RESEARCH',
        sources: sources.slice(0, maxSources).map(s => ({ title: s.title, url: s.url })),
        synthesized_findings: findings.slice(0, 6).map(f => String(f).slice(0, 300)),
        raw_html_external: true
      };
    }

    default: {
      // Default bounded JSON/API reducer
      const text = typeof rawData === 'string' ? rawData : JSON.stringify(rawData);
      const maxBytes = options.maxBytes || 2048;
      if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
        return rawData;
      }
      return {
        status: 'TRUNCATED_TO_RECEIPT',
        connector: normType,
        original_bytes: Buffer.byteLength(text, 'utf8'),
        preview: text.slice(0, maxBytes),
        full_evidence_pointer: options.evidencePointer || 'external:tool_output'
      };
    }
  }
}

/**
 * Format a pagination envelope instead of a dump (Section 12).
 */
function paginateOutput(items = [], { page = 1, pageSize = 8, cursor = null, filterFn = null } = {}) {
  const filtered = typeof filterFn === 'function' ? items.filter(filterFn) : items;
  const start = (page - 1) * pageSize;
  const pageItems = filtered.slice(start, start + pageSize);
  const total = filtered.length;
  const hasMore = start + pageSize < total;
  const nextCursor = hasMore ? `cursor_${start + pageSize}` : null;

  return {
    page,
    page_size: pageSize,
    total_items: total,
    has_more: hasMore,
    cursor: nextCursor,
    items: pageItems
  };
}

module.exports = {
  reduceToolResult,
  reduceConnectorOutput,
  paginateOutput,
  CONNECTOR_LIMITS,
  DEFAULT_MAX_RECEIPT_BYTES
};
