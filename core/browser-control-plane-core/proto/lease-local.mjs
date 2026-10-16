import fs from 'node:fs/promises';
import { existsSync, renameSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const lockPathFor = port => path.join(os.tmpdir(), 'pai-cp-browser-lease-' + port + '.json');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const unlink = async file => {
  try { await fs.unlink(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
};
const claimByRename = (lockPath, token) => {
  const trash = lockPath + '.claim-' + process.pid + '-' + token + '-' + Date.now();
  try { renameSync(lockPath, trash); return trash; } catch { return null; }
};
const restoreClaim = (trash, lockPath) => {
  // Keep a displaced owner's record as an orphan if the path is occupied.
  if (!existsSync(lockPath)) renameSync(trash, lockPath);
};

// getTargets is accepted for API compatibility and intentionally unused.
export async function acquireLease(port, ownerId, token, getTargets, ttlSeconds) {
  const lockPath = lockPathFor(port);
  for (let attempt = 0; attempt < 5; attempt++) {
    const acquiredAt = Date.now();
    const record = { port, ownerId, token, acquiredAt, expiresAt: acquiredAt + (ttlSeconds || 900) * 1000 };
    try {
      await fs.writeFile(lockPath, JSON.stringify(record), { flag: 'wx' });
      return { ok: true, lease: record };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    let existing = null;
    let observed;
    try {
      observed = await fs.readFile(lockPath);
      existing = JSON.parse(observed.toString('utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    if (!existing || Date.now() > existing.expiresAt || existing.token === token) {
      const trash = claimByRename(lockPath, token);
      if (!trash) return { ok: false, reason: 'LEASE_HELD' };
      const claimed = await fs.readFile(trash);
      if (!observed || !claimed.equals(observed)) {
        restoreClaim(trash, lockPath);
        return { ok: false, reason: 'LEASE_HELD' };
      }
      await unlink(trash);
    } else {
      return { ok: false, reason: 'LEASE_HELD', heldBy: existing.ownerId ?? null, expiresAt: existing.expiresAt ?? null };
    }
    if (attempt < 4) await sleep(150);
  }
  return { ok: false, reason: 'LEASE_HELD' };
}

export async function verifyLease(lease, getTargets) {
  let record;
  try {
    record = JSON.parse(await fs.readFile(lockPathFor(lease.port), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    return { ok: false, reason: 'LEASE_NOT_HELD' };
  }
  if (!record || typeof record !== 'object') return { ok: false, reason: 'LEASE_NOT_HELD' };
  if (record.token !== lease.token) return { ok: false, reason: 'LEASE_TOKEN_MISMATCH' };
  if (!(Date.now() <= record.expiresAt)) return { ok: false, reason: 'LEASE_EXPIRED' };
  return { ok: true };
}

export async function releaseLease(lease) {
  const lockPath = lockPathFor(lease.port);
  const trash = claimByRename(lockPath, lease.token);
  if (!trash) return { ok: false, released: false, reason: 'NO_LOCK' };
  let record;
  try {
    record = JSON.parse(await fs.readFile(trash, 'utf8'));
  } catch (error) {
    restoreClaim(trash, lockPath);
    if (!(error instanceof SyntaxError)) throw error;
    return { ok: false, released: false, reason: 'NOT_OWNER' };
  }
  if (record?.token !== lease.token) {
    restoreClaim(trash, lockPath);
    return { ok: false, released: false, reason: 'NOT_OWNER' };
  }
  await unlink(trash);
  return { ok: true };
}
