import path from 'node:path';

// config.mjs — GitHub Control Plane shared config
// Self-contained deploy cho MSI. Mọi module trong control plane đọc config này,
// KHÔNG hardcode port/path. Deploy dir: C:\temp\github-cp\ (tuyệt đối không đè
// C:\temp\suno-cp\, C:\temp\chatgpt-cp\, C:\temp\chatgpt\, C:\temp\social\)

export const cdpUrl =
  process.env.GITHUB_CP_CDP || 'http://127.0.0.1:9336'; // Chrome dùng chung profile social trên MSI (cùng port 9336 với Suno CP)

const baseDir = process.env.GITHUB_CP_DIR || 'C:\\temp\\github-cp';
export const deployDir = baseDir;

export const evidenceDir = process.env.GITHUB_CP_DIR ? path.join(baseDir, 'evidence') : 'C:\\temp\\github-cp\\evidence';

export const idempotencyFile = process.env.GITHUB_CP_DIR ? path.join(baseDir, 'idempotency.jsonl') : 'C:\\temp\\github-cp\\idempotency.jsonl';
