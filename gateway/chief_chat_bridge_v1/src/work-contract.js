'use strict';
// Durable TaskBox work has one relative mutable scope and neutral capabilities.
const SCOPE = /^(?!\/)(?![A-Za-z]:)(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const PROVIDER = /^(CODEX|ANTIGRAVITY|GROK|CHATGPT)_LOCAL$/;
const validMutableScope = value => typeof value === 'string' &&
  (value === 'NONE' || SCOPE.test(value));
const providerCapability = value => typeof value === 'string' && PROVIDER.test(value);
module.exports = { validMutableScope, providerCapability };
