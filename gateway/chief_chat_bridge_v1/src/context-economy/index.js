'use strict';

const { VERSION, compactHealth } = require('./health-compact');
const {
  reduceToolResult,
  reduceConnectorOutput,
  paginateOutput,
  CONNECTOR_LIMITS,
  DEFAULT_MAX_RECEIPT_BYTES
} = require('./tool-result-reducer');
const {
  ContextBudgetLedger,
  createContextBudgetLedger
} = require('./context-budget-ledger');
const {
  formatMaterialDeltaResponse,
  passesMaterialityFilter,
  calculateRepetitionMetrics
} = require('./material-delta');
const {
  createContextMiss,
  createBuilderMissionCapsule,
  createBuilderResult,
  createIndependentQAContext,
  classifyContextOrigin
} = require('./context-contracts');
const {
  OUTWARD_CONTRACT_TYPES,
  OUTWARD_BUDGETS,
  formatTypedOutwardResult
} = require('./typed-outward-contracts');

module.exports = {
  VERSION,
  compactHealth,
  reduceToolResult,
  reduceConnectorOutput,
  paginateOutput,
  CONNECTOR_LIMITS,
  DEFAULT_MAX_RECEIPT_BYTES,
  ContextBudgetLedger,
  createContextBudgetLedger,
  formatMaterialDeltaResponse,
  passesMaterialityFilter,
  calculateRepetitionMetrics,
  createContextMiss,
  createBuilderMissionCapsule,
  createBuilderResult,
  createIndependentQAContext,
  classifyContextOrigin,
  OUTWARD_CONTRACT_TYPES,
  OUTWARD_BUDGETS,
  formatTypedOutwardResult
};
