'use strict';

// chatgpt-web-config.js
// ChatGPT Web provider configuration.
// The browser is owned by the user. This module only names the loopback
// CDP attach point. It never stores or logs cookies, tokens, or passwords.

const path = require('node:path');

const PROFILE_DIR_DEFAULT = path.join(
  process.env.PROGRAMDATA || 'C:\\ProgramData',
  'PAI_CHIEF',
  'personal',
  'chatgpt-web-profile'
);

const CHATGPT_URL = 'https://chatgpt.com';
const CHATGPT_TEMP_CHAT_URL = 'https://chatgpt.com/?temporary-chat=true';
const DEFAULT_CDP_URL = 'http://127.0.0.1:9222';

function loadConfig() {
  const mode = (process.env.CHATGPT_WEB_MODE || 'ATTACH').toUpperCase();
  const launcherUrl = process.env.CHATGPT_LAUNCHER_URL || 'http://127.0.0.1:38080';
  const timeoutMs = parseInt(process.env.CHATGPT_WEB_TIMEOUT_MS || '90000', 10);
  // LAUNCHER_API was declared and never implemented. Reuse that localhost
  // URL as the CDP attach point instead of adding a launcher server.
  // PLAYWRIGHT launch is retired; an explicit PLAYWRIGHT mode still attaches.
  let cdpUrl = process.env.CHATGPT_CDP_URL || DEFAULT_CDP_URL;
  if (!process.env.CHATGPT_CDP_URL && mode === 'LAUNCHER_API') cdpUrl = launcherUrl;

  return Object.freeze({
    mode,
    cdpUrl,
    launcherUrl,
    profileDir: process.env.CHATGPT_WEB_PROFILE_DIR || PROFILE_DIR_DEFAULT,
    chatgptUrl: CHATGPT_URL,
    tempChatUrl: CHATGPT_TEMP_CHAT_URL,
    timeoutMs,
    // Ignored. PAI does not launch the browser.
    headless: process.env.CHATGPT_WEB_HEADLESS !== '0',
  });
}

module.exports = { loadConfig };
