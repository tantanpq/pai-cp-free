'use strict';

const NAME_ONLY_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: true,
  properties: {}
});

function requestedToolName(params = {}) {
  const raw = params.name ?? params.tool ?? params.toolName ?? params.tool_name;
  if (raw == null || raw === '') return null;
  if (Array.isArray(raw)) {
    if (raw.length !== 1) {
      const err = new Error('BROAD_SCHEMA_DISCOVERY_DENIED');
      err.code = 'BROAD_SCHEMA_DISCOVERY_DENIED';
      throw err;
    }
    return String(raw[0]);
  }
  const name = String(raw).trim();
  if (!name) return null;
  if (name.includes(',') || name.includes(' ')) {
    const err = new Error('BROAD_SCHEMA_DISCOVERY_DENIED');
    err.code = 'BROAD_SCHEMA_DISCOVERY_DENIED';
    throw err;
  }
  return name;
}

function nameOnlyCard(def) {
  return {
    name: def.name,
    description: def.description,
    annotations: def.annotations,
    inputSchema: NAME_ONLY_SCHEMA,
    _meta: {
      schemaHydration: 'NAME_ONLY',
      exactSchemaVia: 'tools/get',
      invariant: 'VERIFY != HYDRATE'
    }
  };
}

function projectToolsList(catalog, params = {}) {
  const list = Array.isArray(catalog) ? catalog : [];
  const exactName = requestedToolName(params);
  if (exactName) {
    const tool = list.find(t => t && t.name === exactName);
    if (!tool) {
      const err = new Error('TOOL_SCHEMA_NOT_FOUND');
      err.code = 'TOOL_SCHEMA_NOT_FOUND';
      throw err;
    }
    return {
      tools: [tool],
      hydration: 'EXACT_ONE_SCHEMA',
      schemaBytes: Buffer.byteLength(JSON.stringify([tool]), 'utf8')
    };
  }
  if (params.schemaMode === 'FULL' || params.hydrateSchemas === true || params.includeInputSchema === true) {
    const err = new Error('BROAD_SCHEMA_DISCOVERY_DENIED');
    err.code = 'BROAD_SCHEMA_DISCOVERY_DENIED';
    throw err;
  }
  const tools = list.map(nameOnlyCard);
  return {
    tools,
    hydration: 'NAME_ONLY',
    schemaBytes: Buffer.byteLength(JSON.stringify(tools), 'utf8')
  };
}

function projectExactToolSchema(catalog, params = {}) {
  const name = requestedToolName(params);
  if (!name) {
    const err = new Error('TOOL_NAME_REQUIRED');
    err.code = 'TOOL_NAME_REQUIRED';
    throw err;
  }
  return projectToolsList(catalog, { name });
}

module.exports = {
  NAME_ONLY_SCHEMA,
  requestedToolName,
  nameOnlyCard,
  projectToolsList,
  projectExactToolSchema
};
