import path from 'node:path';

// config.mjs — REA Control Plane shared config
// Build-time website-map tool (NOT a runtime service plane).
// Self-contained deploy cho MSI. Mọi module trong control plane đọc config này,
// KHÔNG hardcode port/path. Deploy dir: C:\temp\rea-cp\

export const cdpUrl =
  process.env.REA_CP_CDP || 'http://127.0.0.1:9336'; // Chrome chung MSI (shared profile, port 9336)

export const cdpEndpoint = process.env.REA_CP_ENDPOINT || 'http://127.0.0.1:9336'; // cho `rea list-browser-targets <endpoint>` — cần prefix http://

export const reaBin = process.env.REA_CP_BIN || 'npx.cmd -y rea-agents@latest'; // MSI: npx.cmd, .ps1 bị execution policy chặn

const baseDir = process.env.REA_CP_DIR || 'C:\\temp\\rea-cp';
export const deployDir = baseDir;

export const evidenceDir = process.env.REA_CP_DIR ? path.join(baseDir, 'evidence') : 'C:\\temp\\rea-cp\\evidence';

export const idempotencyFile = process.env.REA_CP_DIR ? path.join(baseDir, 'idempotency.jsonl') : 'C:\\temp\\rea-cp\\idempotency.jsonl';
