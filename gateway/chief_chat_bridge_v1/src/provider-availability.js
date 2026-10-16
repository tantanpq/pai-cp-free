'use strict';
// Reuse Chief's receipt owner; no queue, timer, schema or operational authority.
function createProviderAvailabilityStore(db) {
  if (!db) return null;
  const read = db.prepare('SELECT body_json FROM chief_bridge_receipts WHERE receipt_key=?');
  const write = db.prepare('INSERT OR REPLACE INTO chief_bridge_receipts (receipt_key,input_hash,body_json,created_at) VALUES (?,?,?,?)');
  const remove = db.prepare('DELETE FROM chief_bridge_receipts WHERE receipt_key=?');
  const key = id => `chief_provider_availability:${id}`;
  return {
    get(id) {
      const row = read.get(key(id));
      if (!row) return null;
      const value = JSON.parse(row.body_json);
      if (value.state !== 'UNAVAILABLE' || value.retryHorizon !== 'UNTIL_EXPLICIT_READINESS_REFRESH') {
        throw new Error('PROVIDER_AVAILABILITY_RECEIPT_INVALID');
      }
      return value;
    },
    put(id, value) {
      if (value == null) return remove.run(key(id));
      const bytes = JSON.stringify(value);
      write.run(key(id), require('node:crypto').createHash('sha256').update(bytes).digest('hex'), bytes, new Date().toISOString());
    }
  };
}
module.exports = { createProviderAvailabilityStore };
