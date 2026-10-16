'use strict';

function compactGovernedResult(input = {}) {
  return {
    requestId: input.request_id || input.requestId || null,
    chiefState: input.chief_state || input.chiefState || null,
    admissionState: input.admission_state || input.admissionState || null,
    paiTaskId: input.pai_task_id || input.paiTaskId || null,
    lifecycleState: input.lifecycle_state || input.lifecycleState || null,
    selectedExecutor: input.selected_executor_if_assigned || input.selectedExecutor || null,
    resultRef: input.result_ref || input.resultRef || null,
    blocker: input.blocker || null,
    nextAutomatic: input.next_automatic || input.nextAutomatic || null,
    tanDecisionRequired: Boolean(input.tan_decision_required || input.tanDecisionRequired),
    semanticTaskDone: false
  };
}

function toExecutionReceipt(sessionResult = {}) {
  return {
    commandState: sessionResult.state || sessionResult.status || 'UNKNOWN',
    sessionId: sessionResult.sessionId || sessionResult.session?.sessionId || null,
    host: sessionResult.ownerHost || sessionResult.session?.ownerHost || null,
    effectClass: sessionResult.effectClass || sessionResult.session?.effectClass || null,
    outputRef: sessionResult.outputRef || null,
    semanticTaskDone: false,
    semanticReconciliationRequired: true
  };
}

module.exports = { compactGovernedResult, toExecutionReceipt };
