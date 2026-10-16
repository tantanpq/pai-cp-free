'use strict';

const crypto = require('node:crypto');
const contract = require('../contracts/chief-contract-v1.json');

const DIRECT = new Set(contract.directPolicy.allowedIntentClasses);
const DELEGATED = new Set(contract.delegatedPolicy.requiredIntentClasses);
const stable = value => Array.isArray(value) ? `[${value.map(stable).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}` : JSON.stringify(value);
const hash = value => crypto.createHash('sha256').update(stable(value)).digest('hex');
const deny = code => { throw new Error(code); };
const requireFields = (value, fields, code) => { if (!value || fields.some(field => value[field] === undefined || value[field] === null || value[field] === '')) deny(code); };

function validateContract(value = contract) {
  requireFields(value, ['contractId', 'version', 'status', 'role', 'actorType', 'semanticAuthority', 'runtimeFactPrecedence', 'governance', 'directPolicy', 'delegatedPolicy', 'contextReceipt', 'lifecycle', 'rollback', 'prohibited'], 'CHIEF_CONTRACT_INVALID');
  if (value.role !== 'PAI_CHIEF' || value.actorType !== 'GOVERNED_DURABLE_ACTOR' || value.status !== 'ACTIVE') deny('CHIEF_CONTRACT_IDENTITY_INVALID');
  if (!value.governance.governorIsSoleFinalNodeSelector || !value.governance.governorIsSoleClaimAndGraphAdvanceAuthority) deny('CHIEF_GOVERNOR_AUTHORITY_REQUIRED');
  const forbiddenIdentity = ['NODE', 'MODEL', 'PROMPT', 'GOVERNOR', 'PLANNER', 'QUEUE_AUTHORITY', 'CLAIM_AUTHORITY', 'CANONICAL_WRITER'];
  if (!forbiddenIdentity.every(item => value.governance.chiefIsNot.includes(item))) deny('CHIEF_IDENTITY_BOUNDARY_INVALID');
  if (!Array.isArray(value.directPolicy.allowedIntentClasses) || !Array.isArray(value.delegatedPolicy.requiredIntentClasses) || !Array.isArray(value.contextReceipt.requiredFields)) deny('CHIEF_CONTRACT_INVALID');
  return { ok: true, contractId: value.contractId, version: value.version, contractHash: hash(value) };
}

function classifyIntent(intent) {
  requireFields(intent, ['intentClass'], 'CHIEF_INTENT_INVALID');
  if (DIRECT.has(intent.intentClass)) {
    if (intent.requestsMutation || intent.requestsExternalCommitment || intent.requestsAuthorityTransfer) deny('CHIEF_DIRECT_EFFECT_DENIED');
    return { mode: 'DIRECT', intentClass: intent.intentClass, mayMutate: false, mayCommitExternally: false };
  }
  if (DELEGATED.has(intent.intentClass)) return { mode: 'DELEGATED', intentClass: intent.intentClass, mayMutate: false, mayCommitExternally: false };
  deny('CHIEF_INTENT_CLASS_UNKNOWN');
}

function createContextReceipt({ semanticSources, runtimeFacts, authorityBoundary, now = new Date().toISOString() }) {
  validateContract();
  if (!Array.isArray(semanticSources) || !semanticSources.length || !Array.isArray(runtimeFacts) || !authorityBoundary) deny('CHIEF_CONTEXT_EVIDENCE_REQUIRED');
  const receipt = { receiptId: `CHIEF_CONTEXT:${hash({ semanticSources, runtimeFacts, authorityBoundary }).slice(0, 24)}`, chiefContractId: contract.contractId, chiefContractVersion: contract.version, semanticSources, runtimeFacts, authorityBoundary, createdAt: now };
  requireFields(receipt, contract.contextReceipt.requiredFields, 'CHIEF_CONTEXT_RECEIPT_INVALID');
  return receipt;
}

function createDelegation({ request, contextReceipt }) {
  validateContract();
  const classification = classifyIntent(request);
  if (classification.mode !== 'DELEGATED') deny('CHIEF_DELEGATION_NOT_REQUIRED');
  requireFields(request, contract.delegatedPolicy.requiredReceiptFields, 'CHIEF_DELEGATION_RECEIPT_INVALID');
  if (request.route && request.route !== contract.delegatedPolicy.requiredRoute) deny('CHIEF_DELEGATION_ROUTE_DENIED');
  requireFields(contextReceipt, contract.contextReceipt.requiredFields, 'CHIEF_CONTEXT_RECEIPT_INVALID');
  return {
    delegationId: `CHIEF_DELEGATION:${hash({ request, receiptId: contextReceipt.receiptId }).slice(0, 24)}`,
    route: 'GOVERNOR',
    status: 'REQUESTED_NOT_ADMITTED',
    classification,
    contextReceiptId: contextReceipt.receiptId,
    request: { ...request, route: 'GOVERNOR' },
    chiefAuthority: 'REQUEST_ONLY_NO_NODE_CLAIM_OR_GRAPH_AUTHORITY'
  };
}

module.exports = { contract, hash, validateContract, classifyIntent, createContextReceipt, createDelegation };
