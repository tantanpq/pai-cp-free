'use strict';

const { buildHostControlWorkSpec } = require('./host-control-profile.cjs');

// This produces a candidate request envelope only. The live binder MUST map it
// against the currently discovered pai_action_run schema before submission.
function buildPaiActionRunRequest(input) {
  const workSpec = buildHostControlWorkSpec(input);
  return {
    tool: 'pai_action_run',
    arguments: {
      request_id: input.requestId,
      intent: input.intent || 'RUNTIME_ACTION',
      objective: input.objective || `${input.operation} through governed Host Control persistent-session profile`,
      scope: input.mutableScope || 'NONE',
      effect_class: input.effectClass,
      requested_mode: input.requestedMode || 'candidate-only',
      workSpec
    },
    bindingNotes: {
      schemaStatus: 'DISCOVER_LIVE_BEFORE_CALL',
      publicRawShellToolRequired: false,
      createsAuthority: false,
      createsControlPlane: false
    }
  };
}

module.exports = { buildPaiActionRunRequest };
