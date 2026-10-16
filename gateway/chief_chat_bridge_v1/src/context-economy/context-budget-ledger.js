'use strict';

/**
 * Context Budget Ledger
 * 
 * Derivative telemetry / read-model only (Section 6).
 * Captures per-turn bounded context metrics without retaining raw prompts,
 * secrets, or source bodies.
 * 
 * Invariant: NOT authority, NOT a truth store.
 */

const crypto = require('node:crypto');

const MAX_LEDGER_ENTRIES = 50;

class ContextBudgetLedger {
  constructor({ maxEntries = MAX_LEDGER_ENTRIES, now = () => new Date().toISOString() } = {}) {
    this.maxEntries = maxEntries;
    this.now = now;
    this.entries = [];
    this.duplicateObjectIds = new Set();
    this.seenCanonicalIdentities = new Set();
  }

  /**
   * Record a single turn's bounded context metrics.
   * 
   * @param {object} turnMetrics
   */
  recordTurn({
    conversationRef = 'session:default',
    profileId = 'BOOT_DISCOVERY',
    toolCount = 4,
    toolSchemaBytes = 0,
    toolResultBytes = 0,
    sourceCount = 0,
    sourceBodyChars = 0,
    contextPackageBytes = 0,
    resumeBytes = 0,
    notebookProjectionBytes = 0,
    duplicateSemanticObjectCount = 0,
    contextMissCount = 0,
    exactFetchCount = 0,
    assistantResponseBytes = 0,
    platformOwnedUnknown = false
  } = {}) {
    const entry = {
      timestamp: this.now(),
      conversation_ref: String(conversationRef).slice(0, 128),
      profile_id: String(profileId).slice(0, 64),
      tool_count: Number(toolCount) || 0,
      tool_schema_bytes: Number(toolSchemaBytes) || 0,
      tool_result_bytes: Number(toolResultBytes) || 0,
      source_count: Number(sourceCount) || 0,
      source_body_chars: Number(sourceBodyChars) || 0,
      context_package_bytes: Number(contextPackageBytes) || 0,
      resume_bytes: Number(resumeBytes) || 0,
      notebook_projection_bytes: Number(notebookProjectionBytes) || 0,
      duplicate_semantic_object_count: Number(duplicateSemanticObjectCount) || 0,
      context_miss_count: Number(contextMissCount) || 0,
      exact_fetch_count: Number(exactFetchCount) || 0,
      assistant_response_bytes: Number(assistantResponseBytes) || 0,
      platform_owned_unknown: Boolean(platformOwnedUnknown)
    };

    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }

    return entry;
  }

  /**
   * Register a semantic object identity and detect cross-carrier duplication (Section 15).
   * Semantic identity = canonicalId:sourceHash:objectType:stableObjectId
   */
  checkAndRecordSemanticObject({ canonicalSourceId, revisionOrHash, semanticObjectType = 'OBJECT', stableObjectId = 'STABLE' }) {
    const canonicalKey = `${canonicalSourceId}:${revisionOrHash}:${semanticObjectType}:${stableObjectId}`;
    const isDuplicate = this.seenCanonicalIdentities.has(canonicalKey);
    if (isDuplicate) {
      this.duplicateObjectIds.add(canonicalKey);
    } else {
      this.seenCanonicalIdentities.add(canonicalKey);
    }
    return {
      isDuplicate,
      canonicalKey,
      totalDuplicatesObserved: this.duplicateObjectIds.size
    };
  }

  /**
   * Produce a telemetry summary report.
   */
  getReport() {
    let totalToolResultBytes = 0;
    let totalSchemaBytes = 0;
    let totalResumeBytes = 0;
    let totalAssistantResponseBytes = 0;
    let totalContextMisses = 0;
    let totalDuplicateObjects = 0;

    for (const e of this.entries) {
      totalToolResultBytes += e.tool_result_bytes;
      totalSchemaBytes += e.tool_schema_bytes;
      totalResumeBytes += e.resume_bytes;
      totalAssistantResponseBytes += e.assistant_response_bytes;
      totalContextMisses += e.context_miss_count;
      totalDuplicateObjects += e.duplicate_semantic_object_count;
    }

    const count = this.entries.length;
    const latest = this.entries[this.entries.length - 1] || null;

    return {
      schema: 'pai-context-budget-ledger/v1',
      status: 'OBSERVABILITY_ONLY',
      total_turns_recorded: count,
      latest_turn: latest,
      summary: {
        avg_tool_count: count ? Number((this.entries.reduce((a, b) => a + b.tool_count, 0) / count).toFixed(1)) : 0,
        avg_resume_bytes: count ? Math.round(totalResumeBytes / count) : 0,
        avg_assistant_bytes: count ? Math.round(totalAssistantResponseBytes / count) : 0,
        total_context_misses: totalContextMisses,
        total_duplicate_semantic_objects: totalDuplicateObjects
      },
      recent_turns: this.entries.slice(-10),
      authority: 'READ_MODEL_TELEMETRY_ONLY_NO_AUTHORITY'
    };
  }

  /**
   * Check drift against an accepted baseline (Section 34).
   */
  checkDrift(baseline = {}) {
    const report = this.getReport();
    const warnings = [];

    const baselineSchemaBytes = baseline.schema_bytes || 7099;
    const baselineResumeBytes = baseline.resume_bytes || 2400;
    const baselineNotebookBytes = baseline.notebook_projection_bytes || 1872;

    const latest = report.latest_turn;
    if (latest) {
      if (latest.tool_schema_bytes > baselineSchemaBytes * 1.2) {
        warnings.push(`SCHEMA_BYTES_DRIFT: +${Math.round(((latest.tool_schema_bytes - baselineSchemaBytes) / baselineSchemaBytes) * 100)}% over baseline`);
      }
      if (latest.resume_bytes > baselineResumeBytes * 1.2) {
        warnings.push(`RESUME_BYTES_DRIFT: +${Math.round(((latest.resume_bytes - baselineResumeBytes) / baselineResumeBytes) * 100)}% over baseline`);
      }
      if (latest.notebook_projection_bytes > baselineNotebookBytes * 1.2) {
        warnings.push(`NOTEBOOK_PROJECTION_DRIFT: +${Math.round(((latest.notebook_projection_bytes - baselineNotebookBytes) / baselineNotebookBytes) * 100)}% over baseline`);
      }
      if (latest.duplicate_semantic_object_count > 0) {
        warnings.push(`SEMANTIC_DUPLICATES_DRIFT: ${latest.duplicate_semantic_object_count} duplicate objects detected`);
      }
    }

    return {
      drift_detected: warnings.length > 0,
      warnings,
      evaluated_against: {
        baselineSchemaBytes,
        baselineResumeBytes,
        baselineNotebookBytes
      }
    };
  }
}

function createContextBudgetLedger(options = {}) {
  return new ContextBudgetLedger(options);
}

module.exports = {
  ContextBudgetLedger,
  createContextBudgetLedger
};
