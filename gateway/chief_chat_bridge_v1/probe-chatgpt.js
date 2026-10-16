'use strict';
// probe-chatgpt-v2.js — waits properly for visible textarea, uses fill()
const { chromium } = require('playwright');
const profileDir = 'C:\\ProgramData\\PAI_CHIEF\\personal\\chatgpt-web-profile';

(async () => {
  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: false, viewport: {width:1280,height:900},
    args: ['--no-sandbox','--disable-blink-features=AutomationControlled']
  });
  const page = await ctx.newPage();
  console.log('Navigating to chatgpt.com...');
  await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });

  // 1. Wait for Cloudflare to clear (title changes from "Just a moment...")
  console.log('Waiting for CF clearance...');
  try {
    await page.waitForFunction(
      () => !document.title.toLowerCase().includes('just a moment') && document.title.length > 0,
      { timeout: 20000 }
    );
  } catch (_) {}
  console.log('Title after CF wait:', await page.title());

  // 2. Wait for a VISIBLE textarea or contenteditable input
  console.log('Waiting for visible input...');
  let inputLocator = null;
  const inputSelectors = [
    'textarea:visible',
    '#prompt-textarea',
    '[data-testid="prompt-textarea"]',
    'div.ProseMirror[contenteditable="true"]',
    'div[contenteditable="true"]',
    'textarea',
  ];
  for (const sel of inputSelectors) {
    try {
      await page.waitForSelector(sel, { state: 'visible', timeout: 8000 });
      inputLocator = page.locator(sel).first();
      console.log('Found visible input with selector:', sel);
      break;
    } catch (_) {}
  }
  if (!inputLocator) {
    console.log('ERROR: No visible input found');
    // Dump what's on page
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 500));
    console.log('Body text:', bodyText);
    await ctx.close();
    return;
  }

  // 3. Fill text and send
  console.log('Typing message...');
  await inputLocator.fill('Reply exactly: PAI_BRAIN_OK');
  await page.waitForTimeout(500);

  // 4. Find and click send button
  const sendSels = [
    '[data-testid="send-button"]',
    'button[aria-label="Send message"]',
    'button[aria-label="Send prompt"]',
    'button[data-testid="fruitjuice-send-button"]',
  ];
  let sent = false;
  for (const sel of sendSels) {
    try {
      const btn = page.locator(sel).first();
      await btn.waitFor({ state: 'visible', timeout: 3000 });
      const enabled = await btn.isEnabled();
      if (enabled) {
        await btn.click();
        sent = true;
        console.log('Sent via:', sel);
        break;
      }
    } catch (_) {}
  }
  if (!sent) {
    await page.keyboard.press('Enter');
    console.log('Sent via Enter key');
  }

  // 5. Wait for response (stop button appears, then disappears)
  await page.waitForTimeout(2000);
  const stopSel = '[data-testid="stop-button"], button[aria-label*="Stop"]';
  try {
    await page.waitForSelector(stopSel, { state: 'visible', timeout: 15000 });
    console.log('Stop button appeared (generation started)');
    await page.waitForSelector(stopSel, { state: 'hidden', timeout: 60000 });
    console.log('Stop button gone (generation done)');
  } catch (e) {
    console.log('Stop button wait note:', e.message.slice(0, 80));
  }
  await page.waitForTimeout(1000);

  // 6. Extract response
  const resp = await page.evaluate(() => {
    const sels = [
      '[data-message-author-role="assistant"] .markdown',
      '[data-message-author-role="assistant"]',
      '.agent-turn',
      '[data-testid*="conversation-turn"]:last-child',
      'article:last-child',
    ];
    for (const sel of sels) {
      const els = document.querySelectorAll(sel);
      if (els && els.length > 0) {
        const t = (els[els.length-1].innerText || els[els.length-1].textContent || '').trim();
        if (t) return { sel, text: t.slice(0, 300) };
      }
    }
    // fallback: dump full page text
    return { sel: 'BODY_FALLBACK', text: (document.body.innerText || '').slice(0, 500) };
  });
  console.log('Response result:', JSON.stringify(resp, null, 2));

  await ctx.close();
})().catch(e => { console.error('FATAL:', e.message.slice(0, 200)); process.exit(1); });
