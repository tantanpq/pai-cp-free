'use strict';

const crypto = require('node:crypto');

function hashText(text) {
  if (typeof text !== 'string') return null;
  return crypto.createHash('sha256').update(text.trim()).digest('hex');
}

function createPaiIdentity({
  paiConversationRef,
  paiTurnRef,
  parentTurnRef = null,
  projectRef = 'PAI_MAIN',
  surface = 'PAI_FEDERATION_GATEWAY',
  provider = 'ANTIGRAVITY',
  providerThreadRef = null,
  providerMessageId = null,
  userText = '',
  previousTurnHash = null,
  createdAt = new Date().toISOString()
}) {
  if (!paiConversationRef || typeof paiConversationRef !== 'string') {
    throw new Error('PAI_CONVERSATION_REF_REQUIRED');
  }
  if (!paiTurnRef || typeof paiTurnRef !== 'string') {
    throw new Error('PAI_TURN_REF_REQUIRED');
  }

  // Exact provider refs: only when genuinely supplied, never fake UUIDs masquerading as provider IDs
  const genuineProviderThreadRef = providerThreadRef && typeof providerThreadRef === 'string' && providerThreadRef.trim()
    ? providerThreadRef.trim()
    : null;
  const genuineProviderMessageRef = providerMessageId && typeof providerMessageId === 'string' && providerMessageId.trim()
    ? providerMessageId.trim()
    : null;

  const userTextHash = hashText(userText);

  return {
    PAI_CONVERSATION_REF: paiConversationRef.trim(),
    PAI_TURN_REF: paiTurnRef.trim(),
    PARENT_TURN_REF: parentTurnRef ? String(parentTurnRef).trim() : null,
    PROJECT_REF: projectRef ? String(projectRef).trim() : 'PAI_MAIN',
    SURFACE: surface ? String(surface).trim() : 'PAI_FEDERATION_GATEWAY',
    PROVIDER: String(provider).toUpperCase(),
    PROVIDER_THREAD_REF: genuineProviderThreadRef,
    PROVIDER_MESSAGE_REF: genuineProviderMessageRef,
    USER_TEXT_HASH: userTextHash,
    PREVIOUS_TURN_HASH: previousTurnHash || null,
    CREATED_AT: createdAt
  };
}

module.exports = {
  createPaiIdentity,
  hashText
};
