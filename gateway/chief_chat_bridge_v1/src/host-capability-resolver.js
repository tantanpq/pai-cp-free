'use strict';

const os = require('node:os');

// ─────────────────────────────────────────────────────────────────────────────
// Host Capability Resolver
// Resolves: targetHost = resolver(intent, requiredCapabilities)
// Currently selects HOME because it hosts PAI runtime.
// Architecture stays dynamic for future multi-host.
// ─────────────────────────────────────────────────────────────────────────────

const KNOWN_HOSTS = Object.freeze([
  {
    hostId: 'HOME_SIMPLE_BODY_01',
    alias: 'HOME',
    os: 'win32',
    arch: os.arch(),
    hostname: os.hostname(),
    capabilities: [
      'TERMINAL_POWERSHELL',
      'FILESYSTEM_LOCAL',
      'SERVICE_CONTROL',
      'PROCESS_CONTROL',
      'NODE_RUNTIME',
      'PAI_RUNTIME_LOCAL',
      'CANONICAL_WORKSPACE_RW',
      'ANTIGRAVITY_LOCAL',
      'GROK_LOCAL'
    ],
    sessionType: 'LOCAL_PROCESS',
    health: 'HEALTHY',
    locality: 'LOCAL_HOST',
    isPaiHost: true
  }
]);

const INTENT_REQUIRED_CAPABILITIES = Object.freeze({
  HOST_INSPECT: ['TERMINAL_POWERSHELL'],
  TERMINAL_COMMAND: ['TERMINAL_POWERSHELL'],
  FILESYSTEM_READ: ['FILESYSTEM_LOCAL'],
  FILESYSTEM_EDIT: ['FILESYSTEM_LOCAL'],
  SERVICE_CONTROL: ['SERVICE_CONTROL'],
  PROCESS_CONTROL: ['PROCESS_CONTROL']
});

/**
 * Resolve the target host for a given intent and required capabilities.
 * @param {string} intent - Host control intent
 * @param {object} options - Additional requirements
 * @returns {object} Resolved host with capabilities and selection reason
 */
function resolveTargetHost(intent, options = {}) {
  const normalizedIntent = String(intent || '').toUpperCase();
  const requiredCapabilities = options.requiredCapabilities
    || INTENT_REQUIRED_CAPABILITIES[normalizedIntent]
    || [];
  const preferredHost = options.preferredHost || null;

  const eligible = [];
  const blockers = [];

  for (const host of KNOWN_HOSTS) {
    // Check health
    if (host.health !== 'HEALTHY') {
      blockers.push({ hostId: host.hostId, reason: 'HOST_UNHEALTHY' });
      continue;
    }

    // Check required capabilities
    const missing = requiredCapabilities.filter(
      cap => !host.capabilities.includes(cap)
    );
    if (missing.length > 0) {
      blockers.push({ hostId: host.hostId, reason: `MISSING_CAPABILITIES: ${missing.join(',')}` });
      continue;
    }

    eligible.push(host);
  }

  if (eligible.length === 0) {
    return {
      resolved: false,
      reason: 'NO_ELIGIBLE_HOST',
      blockers,
      intent: normalizedIntent
    };
  }

  // Prefer explicit host if specified and eligible
  if (preferredHost) {
    const preferred = eligible.find(
      h => h.hostId === preferredHost || h.alias === preferredHost
    );
    if (preferred) {
      return {
        resolved: true,
        host: preferred,
        reason: 'PREFERRED_HOST_SELECTED',
        intent: normalizedIntent
      };
    }
  }

  // Prefer LOCAL_HOST for host control operations
  const localHost = eligible.find(h => h.locality === 'LOCAL_HOST');
  if (localHost) {
    return {
      resolved: true,
      host: localHost,
      reason: 'LOCAL_HOST_SELECTED',
      intent: normalizedIntent
    };
  }

  // Fallback to first eligible
  return {
    resolved: true,
    host: eligible[0],
    reason: 'FIRST_ELIGIBLE_SELECTED',
    intent: normalizedIntent
  };
}

/**
 * Get capabilities summary for a host.
 */
function getHostCapabilities(hostId) {
  const host = KNOWN_HOSTS.find(
    h => h.hostId === hostId || h.alias === hostId
  );
  if (!host) return null;
  return {
    hostId: host.hostId,
    alias: host.alias,
    os: host.os,
    hostname: host.hostname,
    capabilities: [...host.capabilities],
    sessionType: host.sessionType,
    health: host.health,
    locality: host.locality,
    isPaiHost: host.isPaiHost
  };
}

module.exports = {
  resolveTargetHost,
  getHostCapabilities,
  KNOWN_HOSTS,
  INTENT_REQUIRED_CAPABILITIES
};
