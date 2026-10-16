'use strict';

/**
 * PAI Computer Execution Fabric R1 — Runtime Filesystem Containment Guard
 * Preloaded into child Node processes via NODE_OPTIONS='--require ...'
 * Enforces OS/runtime-level filesystem containment for candidate sessions.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const candidateScope = process.env.PAI_CANDIDATE_SCOPE ? path.resolve(process.env.PAI_CANDIDATE_SCOPE).toLowerCase() : null;

const allowedRoots = [
  candidateScope,
  path.resolve(os.tmpdir()).toLowerCase(),
  'c:\\programdata\\pai_chief\\workspaces'
].filter(Boolean);

const forbiddenRoots = [
  'c:\\users\\tom\\my drive\\pai_project\\core\\chief_chat_bridge_v1\\src',
  'c:\\users\\tom\\my drive\\pai_project\\core\\chief_chat_bridge_v1\\contracts',
  'c:\\users\\tom\\my drive\\pai_project\\core\\chief_chat_bridge_v1\\launchers',
  'c:\\programdata\\pai_chief\\generations',
  'c:\\programdata\\pai_chief\\launchers',
  'c:\\windows'
];

function isSafeWriteTarget(targetPath) {
  if (!targetPath || typeof targetPath !== 'string') return true;
  let resolved = path.resolve(targetPath);
  try {
    if (fs.existsSync(resolved)) {
      resolved = fs.realpathSync(resolved);
    }
  } catch (_) {}
  const norm = path.normalize(resolved).toLowerCase();

  // 1. Strict Negative Check
  for (const f of forbiddenRoots) {
    if (norm === f || norm.startsWith(f + path.sep) || norm.startsWith(f + '/')) {
      return false;
    }
  }

  // 2. Positive Scope Check if candidate scope is defined
  if (candidateScope) {
    for (const r of allowedRoots) {
      if (norm === r || norm.startsWith(r + path.sep) || norm.startsWith(r + '/')) {
        return true;
      }
    }
    return false;
  }

  return true;
}

function wrapSync(orig, name) {
  if (!orig) return orig;
  return function guardedSync(...args) {
    const target = args[0];
    if (typeof target === 'string' && !isSafeWriteTarget(target)) {
      const err = new Error(`EPERM: operation not permitted, write target "${target}" outside candidate scope forbidden by PAI OS containment`);
      err.code = 'EPERM';
      throw err;
    }
    return orig.apply(this, args);
  };
}

function wrapAsync(orig, name) {
  if (!orig) return orig;
  return function guardedAsync(...args) {
    const target = args[0];
    if (typeof target === 'string' && !isSafeWriteTarget(target)) {
      const cb = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
      const err = new Error(`EPERM: operation not permitted, write target "${target}" outside candidate scope forbidden by PAI OS containment`);
      err.code = 'EPERM';
      if (cb) {
        process.nextTick(() => cb(err));
        return;
      }
      return Promise.reject(err);
    }
    return orig.apply(this, args);
  };
}

// Monkey-patch synchronous fs writes
if (fs.writeFileSync) fs.writeFileSync = wrapSync(fs.writeFileSync, 'writeFileSync');
if (fs.appendFileSync) fs.appendFileSync = wrapSync(fs.appendFileSync, 'appendFileSync');
if (fs.mkdirSync) fs.mkdirSync = wrapSync(fs.mkdirSync, 'mkdirSync');
if (fs.copyFileSync) {
  const origCopyFileSync = fs.copyFileSync;
  fs.copyFileSync = function(src, dest, flags) {
    if (typeof dest === 'string' && !isSafeWriteTarget(dest)) {
      const err = new Error(`EPERM: operation not permitted, copy target "${dest}" outside candidate scope forbidden by PAI OS containment`);
      err.code = 'EPERM';
      throw err;
    }
    return origCopyFileSync.apply(this, [src, dest, flags]);
  };
}

// Monkey-patch asynchronous fs writes
if (fs.writeFile) fs.writeFile = wrapAsync(fs.writeFile, 'writeFile');
if (fs.appendFile) fs.appendFile = wrapAsync(fs.appendFile, 'appendFile');
if (fs.mkdir) fs.mkdir = wrapAsync(fs.mkdir, 'mkdir');
if (fs.createWriteStream) {
  const origCreateWriteStream = fs.createWriteStream;
  fs.createWriteStream = function(p, opts) {
    if (typeof p === 'string' && !isSafeWriteTarget(p)) {
      const err = new Error(`EPERM: operation not permitted, write target "${p}" outside candidate scope forbidden by PAI OS containment`);
      err.code = 'EPERM';
      throw err;
    }
    return origCreateWriteStream.apply(this, [p, opts]);
  };
}

if (fs.openSync) {
  const origOpenSync = fs.openSync;
  fs.openSync = function(p, flags, ...rest) {
    const f = String(flags || 'r');
    if ((f.includes('w') || f.includes('a') || f.includes('+')) && typeof p === 'string' && !isSafeWriteTarget(p)) {
      const err = new Error(`EPERM: operation not permitted, write target "${p}" outside candidate scope forbidden by PAI OS containment`);
      err.code = 'EPERM';
      throw err;
    }
    return origOpenSync.apply(this, [p, flags, ...rest]);
  };
}

// Monkey-patch fs/promises
if (fs.promises) {
  if (fs.promises.writeFile) fs.promises.writeFile = wrapAsync(fs.promises.writeFile, 'promises.writeFile');
  if (fs.promises.appendFile) fs.promises.appendFile = wrapAsync(fs.promises.appendFile, 'promises.appendFile');
  if (fs.promises.mkdir) fs.promises.mkdir = wrapAsync(fs.promises.mkdir, 'promises.mkdir');
  if (fs.promises.open) {
    const origPromOpen = fs.promises.open;
    fs.promises.open = function(p, flags, ...rest) {
      const f = String(flags || 'r');
      if ((f.includes('w') || f.includes('a') || f.includes('+')) && typeof p === 'string' && !isSafeWriteTarget(p)) {
        const err = new Error(`EPERM: operation not permitted, write target "${p}" outside candidate scope forbidden by PAI OS containment`);
        err.code = 'EPERM';
        return Promise.reject(err);
      }
      return origPromOpen.apply(this, [p, flags, ...rest]);
    };
  }
}

module.exports = { isSafeWriteTarget };
