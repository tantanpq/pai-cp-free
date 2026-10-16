'use strict';

// J1 is a bounded, shadow-only layer over S0.  It resolves Role Contracts and
// never creates a second claim, queue, scheduler, or graph authority.
const crypto = require('node:crypto');
const ACTORS = new Set(['USER_AI', 'WORKER', 'QA', 'GUILD']);
const DOMAINS = new Set(['RUNTIME', 'TRANSPORT', 'INTEGRATION', 'OBSERVABILITY', 'QA', 'SECURITY', 'DATA']);
const INCIDENT_ROLES = new Set(['MATERIALIZATION', 'ADMISSION', 'LAUNCHER', 'CLAIM_RECOVERY', 'RESULT_RECONCILIATION', 'QA', 'INCIDENT_COMMANDER']);
const LIFECYCLES = new Set(['ACTIVE', 'SUPERSEDED', 'DEPRECATED', 'REVOKED']);
const stable = value => Array.isArray(value) ? `[${value.map(stable).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}` : JSON.stringify(value);
const hash = value => crypto.createHash('sha256').update(stable(value)).digest('hex');
const fail = code => { throw Error(code); };
const required = (value, fields, code) => { if (!value || fields.some(field => value[field] === undefined || value[field] === null || value[field] === '')) fail(code); };

function validateActor(contract) {
  required(contract, ['actorId', 'actorType', 'capabilities', 'forbiddenScopes'], 'ACTOR_CONTRACT_INVALID');
  if (!ACTORS.has(contract.actorType) || !Array.isArray(contract.capabilities) || !Array.isArray(contract.forbiddenScopes)) fail('ACTOR_CONTRACT_INVALID');
  return { ok: true, actorId: contract.actorId, actorType: contract.actorType, contractHash: contract.contractHash || hash(contract) };
}
function validateActorGuidance(contract, actor) {
  required(contract, ['actorId', 'actorType', 'scope', 'purpose', 'authorityEnvelope', 'workflowId', 'pinnedVersions', 'releaseConditions'], 'ACTOR_GUIDANCE_CONTRACT_REQUIRED');
  if (contract.actorId !== actor.actorId || contract.actorType !== actor.actorType) fail('ACTOR_GUIDANCE_ACTOR_MISMATCH');
  if (!Array.isArray(contract.pinnedVersions) || !contract.pinnedVersions.length) fail('ACTOR_GUIDANCE_PIN_REQUIRED');
  return { ok: true, guidanceHash: contract.guidanceHash || hash(contract) };
}
function validateRoleContract(role) {
  required(role, ['id', 'version', 'domain', 'responsibility', 'ownershipBoundary', 'requiredCapabilities', 'authorityEnvelope', 'requiredInputs', 'prohibitedScope', 'workflow', 'successCriteria', 'escalation', 'closePolicy', 'lifecycle'], 'ROLE_CONTRACT_INVALID');
  if (!DOMAINS.has(role.domain)) fail('ROLE_DOMAIN_UNKNOWN');
  if (!LIFECYCLES.has(role.lifecycle)) fail('ROLE_LIFECYCLE_INVALID');
  if (!Array.isArray(role.requiredCapabilities) || !Array.isArray(role.prohibitedScope)) fail('ROLE_CONTRACT_INVALID');
  const roleHash = hash({ ...role, roleHash: undefined });
  if (role.roleHash && role.roleHash !== roleHash) fail('ROLE_HASH_MISMATCH');
  return { ok: true, roleHash };
}
function buildRegistry(roles, { registryId = 'PAI_ROLE_JD_REGISTRY_V1', version = '1.0.0', sourceId = '1t9GVKNQbInr8CjMMYcCpIcl-39eieGLLjeQbNePXkGw', precedence = 'APPROVED_GRAPH_THEN_ADMITTED_RUNTIME' } = {}) {
  if (!Array.isArray(roles) || !roles.length) fail('JD_REGISTRY_EMPTY');
  const entries = {};
  for (const role of roles) { const result = validateRoleContract(role); if (entries[role.id]) fail('JD_REGISTRY_DUPLICATE_ROLE'); entries[role.id] = { ...role, roleHash: result.roleHash }; }
  const body = { registryId, version, sourceId, precedence, entries };
  return { ...body, registryHash: hash(body) };
}
function resolveJD({ registry, roleId, domain, expectedVersion, expectedHash, scope }) {
  if (!registry || registry.registryHash !== hash({ registryId: registry.registryId, version: registry.version, sourceId: registry.sourceId, precedence: registry.precedence, entries: registry.entries })) fail('JD_REGISTRY_HASH_MISMATCH');
  const role = registry.entries?.[roleId]; if (!role) fail('JD_ROLE_NOT_REGISTERED');
  if (domain && role.domain !== domain) fail('JD_DOMAIN_MISMATCH');
  validateRoleContract(role);
  if (role.lifecycle !== 'ACTIVE') fail(`JD_ROLE_${role.lifecycle}`);
  if (expectedVersion && expectedVersion !== role.version) fail('JD_VERSION_STALE');
  if (expectedHash && expectedHash !== role.roleHash) fail('JD_HASH_MISMATCH');
  if (scope && role.prohibitedScope.includes(scope)) fail('JD_SCOPE_DENIED');
  return { role, receipt: { receiptType: 'JD_RESOLVED', registryId: registry.registryId, registryVersion: registry.version, registryHash: registry.registryHash, sourceId: registry.sourceId, sourcePrecedence: registry.precedence, roleId, roleVersion: role.version, roleHash: role.roleHash, resolvedAt: new Date().toISOString(), invalidation: { on: ['SUPERSEDED', 'DEPRECATED', 'REVOKED', 'VERSION_OR_HASH_CHANGE'], rollback: role.rollback || 'REVERT_TO_PREVIOUS_ACTIVE_PINNED_ROLE' } } };
}
function resolveTemporaryOperatingRole({ registry, roleId, domain, scope, governorCount = 1 }) {
  if (governorCount !== 1) fail('JD_SECOND_GOVERNOR_REJECTED');
  const resolved = resolveJD({ registry, roleId, domain, scope });
  if (!/^JD-PAI-(C0-PROGRAM-COORDINATOR|FIX-WORK|FIX-HOME)-V1$/.test(roleId)) fail('JD_TEMPORARY_ROLE_NOT_REGISTERED');
  return { ...resolved, receipt: { ...resolved.receipt, operatingContract: 'PAI_TEMPORARY_OPERATING_CONTRACT_FIX_HOME_FIX_WORK_C0_V1', authorityAmendment: 'PAI_ROOT_SYSTEM_MAINTAINER_AUTHORITY_AMENDMENT_V1', governorTopology: 'ONE_EXISTING_WORK_GOVERNOR' } };
}
function compilePCLRequirement({ workUnitId, roleId, domain, expectedErrorDomains, authorityMaximum, contextBudget, registry }) {
  required({ workUnitId, roleId, domain, authorityMaximum, contextBudget }, ['workUnitId', 'roleId', 'domain', 'authorityMaximum', 'contextBudget'], 'PCL_JD_REQUIREMENT_INVALID');
  const resolved = resolveJD({ registry, roleId, domain });
  if (String(authorityMaximum) !== String(resolved.role.authorityEnvelope)) fail('PCL_AUTHORITY_EXCEEDS_ROLE');
  return { requirementId: `PCL_JD:${workUnitId}:${roleId}:${resolved.role.version}`, workUnitId, requiredRoleId: roleId, domain, expectedErrorDomains: [...new Set(expectedErrorDomains || [])].sort(), authorityMaximum, contextBudget, registryReference: resolved.receipt, requiredCapabilities: resolved.role.requiredCapabilities, prohibitedScope: resolved.role.prohibitedScope };
}
function incidentKnowledge({ signatures = [], runbook = {}, incidentRole }) {
  if (!INCIDENT_ROLES.has(incidentRole)) fail('INCIDENT_ROLE_UNKNOWN');
  const matches = signatures.filter(x => x.incidentRoles?.includes(incidentRole));
  return { incidentRole, owner: runbook.owner || 'EXISTING_RUN_LOOP', procedure: runbook.procedure || 'EXISTING_RUN_LOOP_ONLY', negativeConstraints: runbook.negativeConstraints || ['NO_NEW_SCHEDULER', 'NO_SECOND_CLAIM_AUTHORITY'], signatures: matches.map(x => ({ signature: x.signature, rootCause: x.rootCause, repair: x.repair, certificationState: x.certificationState || 'VERIFIED_RUNTIME_FAILURE_LEARNING_V1' })) };
}
function bindJD({ actor, actorGuidance, requirement, registry, work, existingBindings = new Set(), incidentCatalog = [], runbook = {} }) {
  validateActor(actor); validateActorGuidance(actorGuidance, actor);
  required(requirement, ['workUnitId', 'requiredRoleId', 'registryReference'], 'PCL_JD_REQUIREMENT_REQUIRED');
  if (!work || work.workUnitId !== requirement.workUnitId) fail('JD_WORK_REQUIREMENT_MISMATCH');
  const resolved = resolveJD({ registry, roleId: requirement.requiredRoleId, domain: requirement.domain, expectedVersion: requirement.registryReference.roleVersion, expectedHash: requirement.registryReference.roleHash, scope: work.mutableScope });
  if ((work.forbiddenScopes || []).some(x => actor.forbiddenScopes.includes(x)) || resolved.role.prohibitedScope.includes(work.mutableScope)) fail('JD_SCOPE_DENIED');
  if (!resolved.role.requiredCapabilities.every(x => actor.capabilities.includes(x))) fail('JD_CAPABILITY_DENIED');
  if (work.authorityMaximum !== requirement.authorityMaximum || work.authorityMaximum !== resolved.role.authorityEnvelope) fail('JD_AUTHORITY_MISMATCH');
  const key = `${actor.actorId}:${work.workUnitId}:${resolved.role.id}:${resolved.role.version}`; if (existingBindings.has(key)) fail('JD_BINDING_DUPLICATE');
  const binding = { bindingId: `JD_BIND:${hash({ key, guidanceHash: actorGuidance.guidanceHash || hash(actorGuidance), registryHash: registry.registryHash }).slice(0, 24)}`, bindingKey: key, shadow: true, actorId: actor.actorId, actorGuidanceHash: actorGuidance.guidanceHash || hash(actorGuidance), workUnitId: work.workUnitId, mutableScope: work.mutableScope, authorityMaximum: work.authorityMaximum, registry: resolved.receipt, incident: incidentKnowledge({ signatures: incidentCatalog, runbook, incidentRole: work.incidentRole || 'QA' }) };
  existingBindings.add(key); return binding;
}
function selectGovernorBinding({ binding, nodes, activeCodexNodes = [], activeMutableScopes = [], governorRoute, fallbackNodeId }) {
  if (!binding?.shadow || !binding.registry?.roleHash) fail('JD_BINDING_REQUIRED');
  const eligible = (nodes || []).filter(node => node.admitted && node.healthy && binding.incident.owner && (node.capabilities || []).includes('CODEX_LOCAL'));
  const byId = new Map(eligible.map(x => [x.nodeId, x])); const selected = eligible.sort((a,b) => (a.load || 0) - (b.load || 0) || String(a.nodeId).localeCompare(String(b.nodeId)))[0];
  if (!selected) fail('JD_NO_ELIGIBLE_NODE');
  const route = governorRoute({ selectedNodeId: selected.nodeId, admittedNodes: nodes.filter(x => x.admitted).map(x => x.nodeId), activeCodexNodes, activeMutableScopes, mutableScope: binding.mutableScope });
  if (route.ok) return { selectedNodeId: selected.nodeId, route, bindingReceipt: binding };
  if (!fallbackNodeId || fallbackNodeId === selected.nodeId || !byId.has(fallbackNodeId)) fail(`JD_FALLBACK_DENIED:${route.reason}`);
  const fallback = governorRoute({ selectedNodeId: fallbackNodeId, admittedNodes: nodes.filter(x => x.admitted).map(x => x.nodeId), activeCodexNodes, activeMutableScopes, mutableScope: binding.mutableScope });
  if (!fallback.ok) fail(`JD_FALLBACK_DENIED:${fallback.reason}`);
  return { selectedNodeId: fallbackNodeId, route: fallback, fallbackFrom: selected.nodeId, bindingReceipt: binding };
}
function assertGovernedDispatch(dispatch) {
  const governed = dispatch?.governedJD; if (!governed) return { ok: true, governed: false };
  if (!governed.binding || !governed.actorGuidance) fail('JD_BINDING_OR_ACTOR_GUIDANCE_REQUIRED');
  if (!governed.binding.shadow || governed.binding.workUnitId !== dispatch.workUnitId || governed.binding.mutableScope !== governed.mutableScope) fail('JD_BINDING_DISPATCH_MISMATCH');
  if (!governed.binding.registry.roleHash || !governed.actorGuidance.guidanceHash) fail('JD_BINDING_PIN_MISSING');
  return { ok: true, governed: true, bindingId: governed.binding.bindingId };
}
function certifyProcedure({ binding, testPassed, directEvidence }) { if (!binding?.bindingId || !testPassed || !directEvidence) fail('PROCEDURE_CERTIFICATION_DENIED'); return { certified: true, bindingId: binding.bindingId }; }
module.exports = { ACTORS, DOMAINS, INCIDENT_ROLES, hash, validateActor, validateActorGuidance, validateRoleContract, buildRegistry, resolveJD, resolveTemporaryOperatingRole, compilePCLRequirement, incidentKnowledge, bindJD, selectGovernorBinding, assertGovernedDispatch, certifyProcedure };
