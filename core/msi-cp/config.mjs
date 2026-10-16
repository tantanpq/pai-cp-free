import path from 'node:path';

// config.mjs — MSI Control Plane shared config
// Self-contained deploy cho MSI. Mọi module trong control plane đọc config này,
// KHÔNG hardcode port/path. Deploy dir: C:\temp\msi-cp\

export const cdpUrl =
  process.env.MSI_CP_CDP || 'http://127.0.0.1:9336'; // Chrome social chung (runner core handshake; xem README § caveat)

const baseDir = process.env.MSI_CP_DIR || 'C:\\temp\\msi-cp';
export const deployDir = baseDir;

export const evidenceDir = process.env.MSI_CP_DIR ? path.join(baseDir, 'evidence') : 'C:\\temp\\msi-cp\\evidence';

export const idempotencyFile = process.env.MSI_CP_DIR ? path.join(baseDir, 'idempotency.jsonl') : 'C:\\temp\\msi-cp\\idempotency.jsonl';
