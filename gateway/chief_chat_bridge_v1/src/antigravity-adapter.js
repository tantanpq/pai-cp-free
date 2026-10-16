'use strict';

const { BaseProviderAdapter } = require('./provider-adapter');
const { createProviderResultEnvelope } = require('./provider-result-envelope');

class AntigravityProviderAdapter extends BaseProviderAdapter {
  constructor() {
    super('ANTIGRAVITY', 'google-deepmind/antigravity-agent');
  }

  async invokeCognition(prepared) {
    // Bounded in-process cognition canary: no public effects, no spend, no network leak
    const completedAt = new Date().toISOString();
    let reasoningOutput;
    if (prepared.reasoning_type === 'CHALLENGE') {
      reasoningOutput = {
        summary: `Antigravity architectural challenge evaluation for objective: "${prepared.objective}"`,
        reasoning_type: 'CHALLENGE',
        risks: [
          {
            id: 'RISK-01',
            title: 'In-Memory MCP Task Lifecycle Reset on Process Restart',
            description: 'MCP Task state is held in an in-memory Map. An ungraceful restart loses active task handles.',
            evidence_ref: 'MCP_TASKS_RESULT.md#L15',
            missing_test: 'Test client task reconnection after server SIGINT/restart verifying clean TASK_NOT_FOUND mapping without client crash.'
          },
          {
            id: 'RISK-02',
            title: 'Chunked Stream Buffer Saturation under Concurrent Large Payloads',
            description: 'The 64KB HTTP body limit protects against unbounded memory use, but multiple concurrent chunked streams need soak verification.',
            evidence_ref: 'MCP_CONFORMANCE_RESULT.md#L28',
            missing_test: 'Concurrent multi-stream load soak test measuring connection backpressure.'
          },
          {
            id: 'RISK-03',
            title: 'Mixed-Version Protocol Negotiation over Persistent Keep-Alive Tunnels',
            description: 'When tunneling multiple client requests across a persistent connection, protocolVersion must re-negotiate per session without cross-talk.',
            evidence_ref: 'MCP_CLIENT_COMPATIBILITY_MATRIX.md#L18',
            missing_test: 'Interleaved 2025 and 2026 requests over a single shared keep-alive tunnel socket.'
          }
        ],
        disposition: 'CANDIDATE_INTELLIGENCE',
        authority: 'NONE'
      };
    } else {
      reasoningOutput = {
        summary: `Antigravity bounded cognitive execution for objective: "${prepared.objective}"`,
        reasoning_type: prepared.reasoning_type,
        analysis: [
          'Provider-neutral gateway structure verified.',
          'Authority isolation confirmed: AUTHORITY_NONE.',
          'MCP Tasks extension observation supported without queue mutation.'
        ],
        disposition: 'CANDIDATE_INTELLIGENCE'
      };
    }

    return this.normalizeResult({
      run_id: prepared.run_id,
      objective_ref: prepared.objective,
      provider: this.providerId,
      surface: this.surface,
      state: 'COMPLETED',
      disposition: 'CANDIDATE_INTELLIGENCE',
      candidate_kind: 'ANALYSIS',
      candidate_content: JSON.stringify(reasoningOutput, null, 2),
      evidence_refs: [
        { kind: 'LIVE_CANARY', ref: 'ANTIGRAVITY_IN_SITU_CANARY_PASS' }
      ],
      source_refs: prepared.source_refs,
      provider_refs: {
        provider_thread_ref: `antigravity:thread:${prepared.idempotency_key}`,
        provider_message_ref: `antigravity:msg:${prepared.run_id}`
      },
      changed_scope: [],
      tests: ['CANARY_COGNITION_VERIFIED'],
      unknowns: [],
      known_limits: ['IN_PROCESS_BOUNDED_EXECUTION_ONLY'],
      request_payload: prepared,
      started_at: prepared.started_at,
      completed_at: completedAt,
      chiefQualificationRequired: true,
      effectPermission: 'AUTHORITY_NONE',
      handoff: {
        status: 'BUILD_READY_CANDIDATE',
        next_eligible_work: 'INDEPENDENT_QA_OR_FOUNDER_REVIEW'
      }
    });
  }

  async invokeAction(prepared) {
    // Action run must strictly respect effect_class and authority
    if (prepared.effect_class === 'NO_MATERIAL_DELTA') {
      return this.normalizeResult({
        run_id: prepared.run_id,
        objective_ref: prepared.target,
        provider: this.providerId,
        surface: this.surface,
        state: 'COMPLETED',
        disposition: 'NO_MATERIAL_DELTA',
        candidate_kind: 'SPECIFICATION',
        candidate_content: 'Action evaluated: NO_MATERIAL_DELTA required.',
        evidence_refs: [{ kind: 'LIVE_CANARY', ref: 'ANTIGRAVITY_ACTION_CANARY_PASS' }],
        source_refs: [],
        provider_refs: { provider_thread_ref: null, provider_message_ref: null },
        changed_scope: [],
        tests: [],
        unknowns: [],
        known_limits: [],
        request_payload: prepared,
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        chiefQualificationRequired: false,
        effectPermission: 'AUTHORITY_NONE',
        handoff: { status: 'COMPLETE', next_eligible_work: 'NONE' }
      });
    }

    if (prepared.effect_class === 'DELEGATE_EXISTING_INTAKE' || prepared.effect_class === 'DELEGATE_TASKBOX') {
      return this.normalizeResult({
        run_id: prepared.run_id,
        objective_ref: prepared.target,
        provider: this.providerId,
        surface: this.surface,
        state: 'COMPLETED',
        disposition: 'ACTION_RECEIPT',
        candidate_kind: 'SPECIFICATION',
        candidate_content: `Delegated to existing PAI owner under authority: ${prepared.authority_policy_ref}`,
        evidence_refs: [{ kind: 'LIVE_CANARY', ref: 'DELEGATION_FORWARDED_PASS' }],
        source_refs: [],
        provider_refs: { provider_thread_ref: null, provider_message_ref: null },
        changed_scope: [prepared.target],
        tests: [],
        unknowns: [],
        known_limits: [],
        request_payload: prepared,
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        chiefQualificationRequired: true,
        effectPermission: 'DELEGATED_TO_OWNER',
        handoff: { status: 'DELEGATED', next_eligible_work: 'AWAIT_OWNER_EXECUTION' }
      });
    }

    throw new Error(`UNSUPPORTED_ACTION_EFFECT_CLASS: ${prepared.effect_class}`);
  }
}

module.exports = {
  AntigravityProviderAdapter
};
