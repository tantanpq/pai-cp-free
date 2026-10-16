/**
 * chatgpt-web-login-helper.js
 *
 * Authentication belongs to the real browser the user started.
 * This helper refuses to launch Playwright or any other automation browser.
 */
'use strict';

console.error('[LOGIN-HELPER] Refusing to launch an automation browser.');
console.error('[LOGIN-HELPER] Sign in inside the real browser you started. PAI only attaches after that window is ready.');
process.exit(2);
