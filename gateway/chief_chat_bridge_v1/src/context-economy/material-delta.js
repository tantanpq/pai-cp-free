'use strict';

/**
 * Material-Delta & Assistant Output Policy
 *
 * Enforces the invariant (Sections 8, 9, 36, 37):
 * Unchanged state is referenced by pointer/ref, not re-expanded into conversation history.
 */

const crypto = require('node:crypto');

const sha256 = value => crypto.createHash('sha256').update(String(value)).digest('hex');

/**
 * Format a response adhering to the material-delta policy.
 *
 * @param {object} input
 * @param {string} input.current - Bounded current state summary
 * @param {string|string[]} input.materialDelta - Only what changed this turn
 * @param {string} input.resultRef - Pointer to terminal result or artifact
 * @param {string} input.next - Next eligible action
 * @param {boolean|string} [input.decisionRequired] - Whether a user decision is needed
 * @param {object} [options]
 * @returns {string} Formatted response string
 */
function formatMaterialDeltaResponse({
  current = 'OPERATIONAL_STEADY',
  materialDelta = 'NONE',
  resultRef = 'pointer:current',
  next = 'WAIT_NEXT_INTENT',
  decisionRequired = false
} = {}, options = {}) {
  const deltaText = Array.isArray(materialDelta) ? materialDelta.join('; ') : String(materialDelta);
  const decisionText = decisionRequired === true || String(decisionRequired).toUpperCase() === 'YES' ? 'YES' : 'NO';

  if (options.json === true) {
    return {
      CURRENT: String(current).trim(),
      MATERIAL_DELTA: deltaText.trim(),
      RESULT_REF: String(resultRef).trim(),
      NEXT: String(next).trim(),
      DECISION_REQUIRED: decisionText
    };
  }

  return [
    `CURRENT:\n${String(current).trim()}`,
    `MATERIAL_DELTA:\n${deltaText.trim()}`,
    `RESULT_REF:\n${String(resultRef).trim()}`,
    `NEXT:\n${String(next).trim()}`,
    `DECISION_REQUIRED:\n${decisionText}`
  ].join('\n\n');
}

/**
 * Evaluates whether an item passes the Materiality Filter (Section 37).
 * "Will this change: decision, action, acceptance, authority, risk, or next work?"
 */
function passesMaterialityFilter({
  changesDecision = false,
  changesAction = false,
  changesAcceptance = false,
  changesAuthority = false,
  changesRisk = false,
  changesNextWork = false,
  item = null
} = {}) {
  const material = changesDecision || changesAction || changesAcceptance || changesAuthority || changesRisk || changesNextWork;
  return {
    is_material: Boolean(material),
    action: material ? 'INCLUDE_IN_DELTA' : 'REFERENCE_ONLY_KEEP_EXTERNAL',
    reasons: [
      changesDecision && 'CHANGES_DECISION',
      changesAction && 'CHANGES_ACTION',
      changesAcceptance && 'CHANGES_ACCEPTANCE',
      changesAuthority && 'CHANGES_AUTHORITY',
      changesRisk && 'CHANGES_RISK',
      changesNextWork && 'CHANGES_NEXT_WORK'
    ].filter(Boolean)
  };
}

/**
 * Measures the repetition ratio between consecutive responses or across conversation history (Section 36).
 * Computes Jaccard / trigram / paragraph similarity of unchanged prose blocks.
 *
 * @param {string[]} responseHistory - Array of assistant responses
 * @returns {object} Repetition metrics
 */
function calculateRepetitionMetrics(responseHistory = []) {
  if (!Array.isArray(responseHistory) || responseHistory.length < 2) {
    return {
      repeat_ratio: 0.0,
      status: 'INSUFFICIENT_HISTORY',
      repeated_paragraphs: 0
    };
  }

  const paragraphsByTurn = responseHistory.map(text => {
    return (text || '').split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 50);
  });

  let totalParagraphsEvaluated = 0;
  let repeatedParagraphsCount = 0;
  const seenParagraphHashes = new Set();

  for (let turn = 0; turn < paragraphsByTurn.length; turn++) {
    for (const p of paragraphsByTurn[turn]) {
      totalParagraphsEvaluated++;
      const hash = sha256(p.toLowerCase().replace(/\s+/g, ' '));
      if (seenParagraphHashes.has(hash)) {
        repeatedParagraphsCount++;
      } else {
        seenParagraphHashes.add(hash);
      }
    }
  }

  const repeatRatio = totalParagraphsEvaluated > 0
    ? Number((repeatedParagraphsCount / totalParagraphsEvaluated).toFixed(3))
    : 0.0;

  return {
    total_paragraphs: totalParagraphsEvaluated,
    repeated_paragraphs: repeatedParagraphsCount,
    repeat_ratio: repeatRatio,
    acceptable_repetition: repeatRatio <= 0.15, // <= 15% repetition is healthy (target < 5%)
    status: repeatRatio <= 0.15 ? 'LOW_REPETITION_HEALTHY' : 'HIGH_REPETITION_WARNING'
  };
}

module.exports = {
  formatMaterialDeltaResponse,
  passesMaterialityFilter,
  calculateRepetitionMetrics
};
