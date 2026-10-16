'use strict';

// chatgpt-web-adapter.js
// PAI Bootstrap Provider V0 — ChatGPT Web Provider Adapter
// Checkpoint A: WEB_BRAIN_LINK_PASS
//
// Browser ownership: attach to a user-started Chromium-family browser over
// loopback CDP. Do not launch a browser. Do not read cookies, tokens, or
// passwords. Do not retry after a send that may have landed.

const crypto = require('node:crypto');
const { BaseProviderAdapter } = require('./provider-adapter');
const { loadConfig } = require('./chatgpt-web-config');
const { applyArtifactHandoff } = require('./provider-result-envelope');

const ERR = Object.freeze({
  AUTH_REQUIRED: 'CHATGPT_AUTH_REQUIRED',
  HUMAN_CHALLENGE: 'CHATGPT_HUMAN_CHALLENGE',
  BROWSER_UNAVAILABLE: 'CHATGPT_BROWSER_UNAVAILABLE',
  RATE_LIMITED: 'CHATGPT_RATE_LIMITED',
  TIMEOUT: 'CHATGPT_TIMEOUT',
  DUPLICATE_SEND: 'CHATGPT_DUPLICATE_SEND',
  RESPONSE_EMPTY: 'CHATGPT_RESPONSE_EMPTY',
  BROWSER_FAILED: 'CHATGPT_BROWSER_FAILED',
  NOT_ENABLED: 'CHATGPT_PROVIDER_NOT_ENABLED',
});

class ChatGPTWebError extends Error {
  constructor(code, detail, options = {}) {
    super(`${code}${detail ? ': ' + detail : ''}`);
    this.name = 'ChatGPTWebError';
    this.code = code;
    this.dispatched = options.dispatched === true;
  }
}

const _sendGuard = new Map();

function sendGuardKey(prepared) {
  return crypto.createHash('sha256')
    .update(JSON.stringify({ o: prepared.objective, r: prepared.reasoning_type, k: prepared.idempotency_key }))
    .digest('hex');
}

function safeLog(tag, msg) {
  process.stderr.write(`[CHATGPT-ADAPTER ${new Date().toISOString()}] ${tag}: ${msg}\n`);
}

let _browser = null;

function assertLoopbackCdp(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch (_) {
    throw new ChatGPTWebError(ERR.BROWSER_UNAVAILABLE, 'CDP URL is invalid');
  }
  const host = String(url.hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (!loopback || (url.protocol !== 'http:' && url.protocol !== 'ws:')) {
    throw new ChatGPTWebError(ERR.BROWSER_UNAVAILABLE, 'CDP attach is loopback-only');
  }
  return url.href;
}

async function getBrowser(cfg) {
  if (_browser) {
    try {
      if (_browser.isConnected()) return _browser;
    } catch (_) {}
    _browser = null;
  }

  assertLoopbackCdp(cfg.cdpUrl);
  const { chromium } = require('playwright');
  safeLog('BROWSER', 'attaching to existing loopback browser');
  try {
    _browser = await chromium.connectOverCDP(cfg.cdpUrl, {
      timeout: 5000,
      isLocal: true,
      noDefaults: true,
    });
  } catch (_) {
    throw new ChatGPTWebError(
      ERR.BROWSER_UNAVAILABLE,
      'No user browser is accepting loopback CDP'
    );
  }
  return _browser;
}

async function openOwnedPage(cfg) {
  const browser = await getBrowser(cfg);
  const context = browser.contexts()[0];
  if (!context) {
    throw new ChatGPTWebError(ERR.BROWSER_UNAVAILABLE, 'Attached browser has no default context');
  }
  const page = await context.newPage();
  return { page, owned: true };
}

async function pageSurface(page) {
  let title = '';
  let loc = 'unknown';
  try {
    const u = new URL(page.url());
    loc = `${u.origin}${u.pathname}`;
  } catch (_) {}
  try { title = String(await page.title() || '').slice(0, 120); } catch (_) {}
  let head = '';
  try {
    head = await page.evaluate(() => {
      const text = document.body && document.body.innerText ? document.body.innerText : '';
      return text.slice(0, 500);
    });
  } catch (_) {}
  return { title, loc, head: String(head || '') };
}

function surfaceKind(surface) {
  const blob = `${surface.title}\n${surface.loc}\n${surface.head}`;
  if (/just a moment|verify you are human|checking your browser|cf-browser-verification|challenges\.cloudflare|cdn-cgi\/challenge/i.test(blob)) {
    return 'CHALLENGE';
  }
  if (/\/auth\/|\/login\b|accounts\.google\.com|auth0\.com/i.test(`${surface.loc}\n${surface.head}`)
      || /\blog in\b|\bsign up\b|welcome back/i.test(surface.head)) {
    return 'AUTH';
  }
  if (/too many requests|rate limit|usage cap/i.test(blob)) {
    return 'RATE';
  }
  return 'OK';
}

function throwForSurface(surface) {
  const where = `url=${surface.loc} title=${surface.title}`;
  const kind = surfaceKind(surface);
  if (kind === 'CHALLENGE') {
    throw new ChatGPTWebError(ERR.HUMAN_CHALLENGE, `Human verification is visible in the user browser. ${where}`);
  }
  if (kind === 'AUTH') {
    throw new ChatGPTWebError(ERR.AUTH_REQUIRED, `ChatGPT session is not authenticated. ${where}`);
  }
  if (kind === 'RATE') {
    throw new ChatGPTWebError(ERR.RATE_LIMITED, `Rate limit visible before send. ${where}`);
  }
}

async function findInputElement(page) {
  const SELECTORS = [
    '#prompt-textarea',
    'div.ProseMirror[contenteditable="true"]',
    '[data-testid="prompt-textarea"]',
    'div[contenteditable="true"][data-placeholder]',
    'div[contenteditable="true"]',
    'textarea',
  ];

  for (const sel of SELECTORS) {
    try {
      const el = await page.$(sel);
      if (el && await el.isVisible()) return { el, sel };
    } catch (_) {}
  }
  return null;
}

async function waitForResponseComplete(page, timeoutMs) {
  const STOP_SELECTORS = [
    '[data-testid="stop-button"]',
    'button[aria-label="Stop generating"]',
    'button[aria-label="Stop streaming"]',
    '[data-testid="fruitjuice-stop-button"]',
    'button svg.icon-stop',
  ];

  // The current ChatGPT UI may never expose a stop button. Wait for actual
  // assistant content and a short quiet period instead of treating absence of
  // that button as completion. A dispatched timeout stays ambiguous upstream.
  const responseSelectors = [
    '[data-message-author-role="assistant"] .markdown',
    '[data-message-author-role="assistant"] .prose',
    'div[class*="MarkdownRoot-"]'
  ];
  await page.waitForFunction(({ stopSelectors, responseSelectors }) => {
    const els = responseSelectors.flatMap(sel => [...document.querySelectorAll(sel)]);
    const latest = els.at(-1);
    const value = latest && (latest.innerText || latest.textContent || '').trim();
    if (!value || stopSelectors.some(sel => document.querySelector(sel))) {
      window.__paiResponseQuiet = null;
      return false;
    }
    const now = performance.now();
    const prior = window.__paiResponseQuiet;
    if (!prior || prior.value !== value) {
      window.__paiResponseQuiet = { value, since: now };
      return false;
    }
    return now - prior.since >= 1800;
  }, { stopSelectors: STOP_SELECTORS, responseSelectors }, { timeout: timeoutMs, polling: 250 })
    .catch(() => { throw new ChatGPTWebError(ERR.TIMEOUT, `Assistant response did not stabilize within ${timeoutMs}ms`); });
}

async function extractResponse(page) {
  return page.evaluate(() => {
    const RESPONSE_SELECTORS = [
      '[data-message-author-role="assistant"] .markdown',
      '[data-message-author-role="assistant"] .prose',
      '[data-message-author-role="assistant"] p',
      '.group\\/conversation-turn:last-child .markdown',
      '.group\\/conversation-turn:last-child .prose',
      'div[class*="agent-turn"] .markdown',
      'div[class*="agent-turn"] .prose',
      'article[data-testid^="conversation-turn"]:last-child',
      'div[class*="MarkdownRoot-"]',
    ];

    for (const sel of RESPONSE_SELECTORS) {
      const els = document.querySelectorAll(sel);
      if (els && els.length > 0) {
        const last = els[els.length - 1];
        const text = last.innerText || last.textContent;
        if (text && text.trim().length > 0) return text.trim();
      }
    }
    return null;
  });
}

async function dispatchOnce(page) {
  const SEND_BTN_SELS = [
    '[data-testid="send-button"]',
    'button[aria-label="Send message"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label="Send"]',
    'button[data-testid="fruitjuice-send-button"]',
  ];
  for (const sel of SEND_BTN_SELS) {
    const btn = await page.$(sel);
    if (!btn) continue;
    const enabled = await btn.isEnabled();
    if (!enabled) continue;
    await btn.click();
    return;
  }
  await page.keyboard.press('Enter');
}

async function sendAndCapture(prepared, cfg) {
  const { page, owned } = await openOwnedPage(cfg);
  let dispatched = false;
  try {
    await page.goto(cfg.tempChatUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    let found = null;
    const inputDeadline = Date.now() + 30000;
    while (!found && Date.now() < inputDeadline) {
      const surface = await pageSurface(page);
      throwForSurface(surface);
      found = await findInputElement(page);
      if (!found) await page.waitForTimeout(1000);
    }

    if (!found) {
      const surface = await pageSurface(page);
      throwForSurface(surface);
      throw new ChatGPTWebError(
        ERR.BROWSER_FAILED,
        `Could not find message input after 30s (url=${surface.loc}, title=${surface.title})`
      );
    }

    safeLog('SEND', `using input selector: ${found.sel}`);
    await found.el.click();
    await page.waitForTimeout(300);
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await page.keyboard.type(prepared.objective, { delay: 15 });
    await page.waitForTimeout(500);

    const beforeSend = await pageSurface(page);
    throwForSurface(beforeSend);
    const rateLimitEl = await page.$('[data-testid="rate-limit-message"], .rate-limit-modal');
    if (rateLimitEl) throw new ChatGPTWebError(ERR.RATE_LIMITED, 'Rate limit before send');

    dispatched = true;
    await dispatchOnce(page);
    safeLog('SEND', 'message sent, waiting for response');

    await waitForResponseComplete(page, cfg.timeoutMs);
    await page.waitForTimeout(500);
    const responseText = await extractResponse(page);
    if (!responseText || !responseText.trim()) {
      throw new ChatGPTWebError(ERR.RESPONSE_EMPTY, 'No response text captured from page');
    }

    safeLog('RECEIVE', `response captured (${responseText.trim().length} chars)`);
    return responseText.trim();
  } catch (err) {
    if (err instanceof ChatGPTWebError) {
      if (dispatched) err.dispatched = true;
      throw err;
    }
    throw new ChatGPTWebError(
      ERR.BROWSER_FAILED,
      err && err.message ? err.message : 'browser fault',
      { dispatched }
    );
  } finally {
    if (owned && page) await page.close().catch(() => {});
  }
}

class ChatGPTWebProviderAdapter extends BaseProviderAdapter {
  constructor() {
    super('CHATGPT', 'openai/chatgpt-web');
    this._cfg = null;
  }

  _getConfig() {
    if (!this._cfg) this._cfg = loadConfig();
    return this._cfg;
  }

  async invokeCognition(prepared) {
    const cfg = this._getConfig();
    const guardKey = sendGuardKey(prepared);
    const existing = _sendGuard.get(guardKey);

    if (existing) {
      if (existing.state === 'inflight' || existing.state === 'ambiguous') {
        throw new ChatGPTWebError(
          ERR.DUPLICATE_SEND,
          existing.state === 'inflight'
            ? 'Identical request already inflight'
            : 'Identical request already dispatched; not retrying'
        );
      }
      if (existing.state === 'done') {
        safeLog('GUARD', 'returning cached result for duplicate idempotency key');
        return existing.result;
      }
    }

    _sendGuard.set(guardKey, { state: 'inflight' });

    let rawText;
    try {
      rawText = await sendAndCapture(prepared, cfg);
    } catch (err) {
      if (err instanceof ChatGPTWebError && err.dispatched) {
        _sendGuard.set(guardKey, { state: 'ambiguous' });
      } else {
        _sendGuard.delete(guardKey);
      }
      if (err instanceof ChatGPTWebError) throw err;
      throw new ChatGPTWebError(ERR.BROWSER_FAILED, err.message);
    }

    const handed = applyArtifactHandoff({
      content: rawText,
      policy: prepared.artifact_policy || 'AUTO',
      sourceRefs: Array.isArray(prepared.source_refs) ? prepared.source_refs : []
    });
    const result = this.normalizeResult({
      run_id: prepared.run_id,
      objective_ref: prepared.objective,
      provider: this.providerId,
      surface: this.surface,
      state: 'COMPLETED',
      disposition: handed.disposition,
      candidate_kind: 'COGNITION_RESPONSE',
      candidate_content: handed.candidate_content,
      summary: handed.summary,
      artifact_ref: handed.artifact ? handed.artifact.ref : null,
      artifact_digest: handed.artifact ? handed.artifact.digest : null,
      evidence_refs: handed.artifact ? [handed.artifact.ref] : [],
      source_refs: Array.isArray(prepared.source_refs) ? prepared.source_refs : [],
      completed_at: new Date().toISOString(),
    });

    _sendGuard.set(guardKey, { state: 'done', result });
    return result;
  }

  static async closeBrowser() {
    if (_browser) {
      try { await _browser.close(); } catch (_) {}
      _browser = null;
    }
  }

  static clearSendGuard() { _sendGuard.clear(); }
}

module.exports = { ChatGPTWebProviderAdapter, ChatGPTWebError, ERR, _sendGuard };
