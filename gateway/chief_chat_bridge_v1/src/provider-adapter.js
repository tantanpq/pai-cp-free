'use strict';

const { createProviderResultEnvelope } = require('./provider-result-envelope');
const { findCard } = require('./capability-cards');

class BaseProviderAdapter {
  constructor(providerId, surface) {
    this.providerId = String(providerId).toUpperCase();
    this.surface = surface;
  }

  async discoverCapabilities() {
    const card = findCard(this.providerId);
    if (!card) {
      return { status: 'UNKNOWN', provider: this.providerId, capabilities: [] };
    }
    return card;
  }

  async prepareCognition(request) {
    if (!request.objective) throw new Error('OBJECTIVE_REQUIRED');
    if (!request.reasoning_type) throw new Error('REASONING_TYPE_REQUIRED');
    return {
      run_id: request.idempotency_key ? `run:${request.idempotency_key}` : `run:${Date.now()}`,
      objective: request.objective,
      reasoning_type: request.reasoning_type,
      source_refs: request.source_refs || [],
      context_budget: request.context_budget || { max_tokens: 4096, timeout_ms: 30000 },
      privacy_boundary: request.privacy_boundary || 'LOCAL_ONLY',
      expected_output: request.expected_output || '',
      idempotency_key: request.idempotency_key,
      started_at: new Date().toISOString()
    };
  }

  async invokeCognition(prepared) {
    throw new Error('NOT_IMPLEMENTED');
  }

  async prepareAction(request) {
    if (!request.target) throw new Error('ACTION_TARGET_REQUIRED');
    if (!request.authority_policy_ref) throw new Error('AUTHORITY_POLICY_REF_REQUIRED');
    return {
      run_id: request.idempotency_key ? `act:${request.idempotency_key}` : `act:${Date.now()}`,
      target: request.target,
      effect_class: request.effect_class || 'NO_MATERIAL_DELTA',
      authority_policy_ref: request.authority_policy_ref,
      idempotency_key: request.idempotency_key,
      action_payload: request.action_payload || {}
    };
  }

  async invokeAction(prepared) {
    throw new Error('NOT_IMPLEMENTED');
  }

  async poll(taskId) {
    return { taskId, state: 'COMPLETED' };
  }

  async cancel(taskId) {
    return { taskId, cancelled: true };
  }

  normalizeResult(raw) {
    return createProviderResultEnvelope(raw);
  }
}

module.exports = {
  BaseProviderAdapter
};
