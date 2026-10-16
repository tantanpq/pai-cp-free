'use strict';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { FederationCore } = require('./federation-core');
const baseBridgeModule = require('./chief-chat-bridge');
const { READ_TOOLS } = require('./pai-read-gateway');
const { reduceToolResult } = require('./context-economy/tool-result-reducer');
const { formatTypedOutwardResult } = require('./context-economy/typed-outward-contracts');
const { projectToolsList, projectExactToolSchema } = require('./context-economy/tool-catalog-projection');
const federationToolSchemas = require('./FEDERATION_TOOL_SCHEMAS.json');

const SUPPORTED_PROTOCOLS = ['2026-07-28', '2025-03-26'];
const PRIMARY_PROTOCOL = '2026-07-28';
const SERVER_INFO = {
  name: 'pai-federation-gateway',
  version: '2.0.0',
  description: 'Governed private PAI Chief and terminal gateway.'
};

function modernResult(result, { cacheable = false } = {}) {
  return {
    ...result,
    resultType: 'complete',
    ...(cacheable ? { ttlMs: 300000, cacheScope: 'private' } : {}),
    _meta: {
      ...(result?._meta || {}),
      'io.modelcontextprotocol/serverInfo': SERVER_INFO
    }
  };
}

function getSourceLockDigest() {
  try {
    const lockPath = path.resolve(__dirname, '..', 'SOURCE_LOCK.json');
    if (fs.existsSync(lockPath)) {
      return crypto.createHash('sha256').update(fs.readFileSync(lockPath)).digest('hex');
    }
  } catch (_) {}
  return null;
}

function createFederationBridge(options = {}) {
  const federationToolDefs = federationToolSchemas.tools;
  const federationToolNames = new Set(federationToolDefs.map(t => t.name));

  const { publicToolNames, ...restOptions } = options;
  const basePublicToolNames = Array.isArray(publicToolNames)
    ? publicToolNames.filter(n => !federationToolNames.has(n))
    : null;

  const baseBridge = baseBridgeModule.createBridge({
    ...restOptions,
    ...(basePublicToolNames ? { publicToolNames: basePublicToolNames } : {})
  });
  const federationCore = new FederationCore(options);

  // Merge tool definitions
  const requestedFedTools = Array.isArray(publicToolNames)
    ? federationToolDefs.filter(t => publicToolNames.includes(t.name))
    : federationToolDefs;

  const allToolDefinitions = [
    ...baseBridge.toolDefinitions,
    ...federationToolDefs
  ];

  const publicToolDefinitions = [
    ...baseBridge.publicToolDefinitions,
    ...requestedFedTools
  ];

  const publicNames = new Set(publicToolDefinitions.map(t => t.name));

  function getCanonicalPublicTools() {
    const toolMap = new Map();
    for (const def of publicToolDefinitions) {
      if (def && def.name && !toolMap.has(def.name)) {
        toolMap.set(def.name, def);
      }
    }
    const targetNames = baseBridgeModule.CHATGPT_PUBLIC_TOOL_NAMES || [
      'chief_resume', 'chief_status', 'pai_get_pulse', 'search', 'fetch', 'chief_turn', 'pai_action_run'
    ];
    const canonical = [];
    for (const name of targetNames) {
      if (toolMap.has(name)) canonical.push(toolMap.get(name));
    }
    return canonical;
  }

  function call(name, input = {}) {
    // 1. Check Federation Plane tools
    if (name === 'pai_capabilities') {
      return federationCore.handleCapabilities(input).then(result => ({
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: { result }
      }));
    }

    if (name === 'pai_cognition_run') {
      return federationCore.handleCognitionRun(input).then(result => ({
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: { result }
      }));
    }

    if (name === 'pai_action_run' || name === 'chief_work_request') {
      return federationCore.handleActionRun(input).then(result => {
        const outwardResult = formatTypedOutwardResult({ toolName: name, input, result });
        return {
          content: [{ type: 'text', text: JSON.stringify(outwardResult) }],
          structuredContent: { result: outwardResult }
        };
      });
    }

    if (name === 'pai_run_status') {
      const accepted = federationCore.resolveAcceptedTask(input.run_id, input.userId);
      if (accepted) {
        const result = { status: accepted.status === 'PENDING' ? String(accepted.lifecycleState || 'pending').toLowerCase() : String(accepted.status).toLowerCase(), task: { taskId: accepted.binding.taskId, runId: accepted.binding.requestId, status: accepted.status, acceptedResult: accepted } };
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: { result } };
      }
      const task = federationCore.getMcpTask(input.run_id);
      const result = task ? { status: task.status, task } : { status: 'NOT_FOUND' };
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: { result }
      };
    }

    if (name === 'pai_result') {
      const accepted = federationCore.resolveAcceptedTask(input.run_id, input.userId);
      if (accepted) {
        const result = ['DONE','NOT_DONE','BLOCKED'].includes(accepted.status) ? { status: accepted.status, structuredResult: accepted, authority: accepted.authority } : { status: accepted.status === 'PENDING' ? 'NO_RESULT_AVAILABLE' : 'RESULT_UNAVAILABLE', blocker: accepted.failureClass || null, structuredResult: accepted };
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: { result } };
      }
      const task = federationCore.getMcpTask(input.run_id);
      const result = task?.result || { status: 'NO_RESULT_AVAILABLE' };
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: { result }
      };
    }

    if (name === 'pai_cancel') {
      const task = federationCore.cancelMcpTask(input.run_id, input.reason);
      const result = task ? { cancelled: true, task } : { cancelled: false, reason: 'NOT_FOUND' };
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: { result }
      };
    }

    // 2. Delegate to baseline bridge for all existing 20 tools (synchronous)
    const baseResult = baseBridge.call(name, input);
    if (name === 'fetch' && baseResult && baseResult.structuredContent) {
      const outwardResult = formatTypedOutwardResult({ toolName: name, input, result: baseResult.structuredContent });
      return {
        content: [{ type: 'text', text: JSON.stringify(outwardResult) }],
        structuredContent: outwardResult
      };
    }
    return baseResult;
  }

  function rpc(request, context = {}) {
    try {
      if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
        throw new Error('BRIDGE_PROTOCOL_INVALID');
      }

      // server/discover: 2026-07-28 discovery endpoint
      if (request.method === 'server/discover') {
        return {
          jsonrpc: '2.0',
          id: request.id ?? null,
          result: modernResult({
            supportedVersions: [PRIMARY_PROTOCOL],
            capabilities: {
              tools: { listChanged: true, cacheable: true, governedWorkOperation: 'pai_action_run' },
              tasks: { supported: true },
              subscriptions: { supported: true, types: ['toolsListChanged', 'resourcesListChanged'] }
            },
            instructions: 'PAI provides governed Chief continuity and bounded terminal execution. Use pai_action_run for terminal sessions and technical work; reuse session_id across terminal lifecycle calls and use a unique request_id for each call.'
          }, { cacheable: true })
        };
      }

      // initialize: protocol negotiation
      if (request.method === 'initialize') {
        const clientProto = request.params?.protocolVersion;
        const agreedProto = (clientProto === '2026-07-28')
          ? '2026-07-28'
          : (clientProto === '2024-11-05' ? '2024-11-05' : '2025-03-26');

        return {
          jsonrpc: '2.0',
          id: request.id ?? null,
          result: {
            protocolVersion: agreedProto,
            capabilities: {
              tools: { listChanged: true, cacheable: true },
              tasks: { supported: true },
              subscriptions: { supported: true }
            },
            serverInfo: {
              name: 'pai-federation-gateway',
              version: '2.0.0'
            },
            instructions: 'PAI Federation Gateway 2026-07-28. External providers are replaceable cognitive supply with AUTHORITY_NONE. PAI remains canonical master of continuity, identity, and authority.'
          }
        };
      }

      // tools/list: name-only catalog. Exact one schema via tools/get or tools/list?name=
      if (request.method === 'tools/list') {
        const catalog = getCanonicalPublicTools();
        const projected = projectToolsList(catalog, request.params || {});
        const isModern = context.protocolVersion === PRIMARY_PROTOCOL;
        const result = {
          tools: projected.tools,
          _meta: {
            'io.pai/catalog': {
              profileId: 'CHATGPT_CANONICAL_PUBLIC',
              toolCount: projected.tools.length,
              schemaBytes: projected.schemaBytes,
              hydration: projected.hydration,
              listChanged: false
            }
          }
        };
        return {
          jsonrpc: '2.0',
          id: request.id ?? null,
          result: isModern ? modernResult(result, { cacheable: true }) : result
        };
      }

      if (request.method === 'tools/get') {
        const projected = projectExactToolSchema(getCanonicalPublicTools(), request.params || {});
        const isModern = context.protocolVersion === PRIMARY_PROTOCOL;
        const result = { tool: projected.tools[0], tools: projected.tools, hydration: projected.hydration };
        return {
          jsonrpc: '2.0',
          id: request.id ?? null,
          result: isModern ? modernResult(result, { cacheable: true }) : result
        };
      }

      // tools/call
      if (request.method === 'tools/call') {
        const supplied = request.params?.arguments ?? {};
        if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) {
          throw new Error('BRIDGE_SCHEMA_INVALID');
        }
        if (options.identity?.userId && Object.prototype.hasOwnProperty.call(supplied, 'userId') && supplied.userId !== options.identity.userId) {
          throw new Error('BRIDGE_IDENTITY_MISMATCH');
        }
        const rawToolName = request.params?.name;
        let strippedName = typeof rawToolName === 'string' ? rawToolName.replace(/^(?:pai_terminal|pai-terminal)[.:]/, '') : rawToolName;
        if (strippedName === 'chief_work_request' || strippedName === 'pai_terminal' || strippedName === 'terminal' || strippedName === 'pai-terminal' || strippedName === '') {
          strippedName = 'pai_action_run';
        }
        const reqToolName = strippedName;
        if (!publicNames.has(reqToolName)) {
          throw new Error('BRIDGE_TOOL_DENIED');
        }
        const { userId: _ignoredUserId, ...toolArguments } = supplied;
        const callInput = {
          ...toolArguments,
          ...(options.identity?.userId ? { userId: options.identity.userId } : {})
        };
        const res = call(reqToolName, callInput);
        const wrapToolResult = val => context.protocolVersion === PRIMARY_PROTOCOL ? modernResult(val) : val;
        if (res && typeof res.then === 'function') {
          return res.then(val => ({
            jsonrpc: '2.0',
            id: request.id ?? null,
            result: wrapToolResult(val)
          })).catch(err => ({
            jsonrpc: '2.0',
            id: request?.id ?? null,
            error: {
              code: -32000,
              message: 'CHIEF_BRIDGE_DENIED',
              data: { code: String(err.message || err) }
            }
          }));
        }
        return {
          jsonrpc: '2.0',
          id: request.id ?? null,
          result: wrapToolResult(res)
        };
      }

      // subscriptions/listen (Modern 2026-07-28 notification subscriptions)
      if (request.method === 'subscriptions/listen') {
        const types = Array.isArray(request.params?.types) ? request.params.types : ['toolsListChanged'];
        return {
          jsonrpc: '2.0',
          id: request.id ?? null,
          result: {
            subscribed: true,
            types,
            activeSubscriptionsCount: types.length,
            authority: 'SUBSCRIPTIONS_ACTIVE'
          }
        };
      }

      // tasks/get (Tasks extension)
      if (request.method === 'tasks/get') {
        const taskId = request.params?.taskId;
        const task = federationCore.getMcpTask(taskId);
        if (!task) {
          return {
            jsonrpc: '2.0',
            id: request.id ?? null,
            error: { code: -32001, message: 'TASK_NOT_FOUND' }
          };
        }
        return {
          jsonrpc: '2.0',
          id: request.id ?? null,
          result: { task }
        };
      }

      // tasks/update (Tasks extension)
      if (request.method === 'tasks/update') {
        const taskId = request.params?.taskId;
        const task = federationCore.getMcpTask(taskId);
        if (!task) {
          return {
            jsonrpc: '2.0',
            id: request.id ?? null,
            error: { code: -32001, message: 'TASK_NOT_FOUND' }
          };
        }
        if (request.params?.payload && typeof request.params.payload === 'object') {
          task.payload = { ...task.payload, ...request.params.payload };
        }
        task.updatedAt = new Date().toISOString();
        return {
          jsonrpc: '2.0',
          id: request.id ?? null,
          result: { task }
        };
      }

      // tasks/cancel (Tasks extension)
      if (request.method === 'tasks/cancel') {
        const taskId = request.params?.taskId;
        const task = federationCore.cancelMcpTask(taskId, request.params?.reason);
        if (!task) {
          return {
            jsonrpc: '2.0',
            id: request.id ?? null,
            error: { code: -32001, message: 'TASK_NOT_FOUND' }
          };
        }
        return {
          jsonrpc: '2.0',
          id: request.id ?? null,
          result: { task }
        };
      }

      throw new Error('BRIDGE_METHOD_DENIED');
    } catch (e) {
      return {
        jsonrpc: '2.0',
        id: request?.id ?? null,
        error: {
          code: -32000,
          message: 'CHIEF_BRIDGE_DENIED',
          data: { code: String(e.message || e) }
        }
      };
    }
  }

  return {
    rpc,
    call,
    federationCore,
    toolDefinitions: allToolDefinitions,
    publicToolDefinitions,
    resolveJitTools: (params, defs) => (typeof baseBridge.resolveJitTools === 'function') ? baseBridge.resolveJitTools(params, defs || publicToolDefinitions) : (defs || publicToolDefinitions),
    projectOutwardResult: (tool, result, profile) => (typeof baseBridge.projectOutwardResult === 'function') ? baseBridge.projectOutwardResult(tool, result, profile) : result,
    sessionId: baseBridge.sessionId,
    storage: baseBridge.storage
  };
}

module.exports = {
  createFederationBridge,
  SUPPORTED_PROTOCOLS,
  PRIMARY_PROTOCOL
};
