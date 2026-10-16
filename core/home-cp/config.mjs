import path from 'node:path';

// config.mjs — HOME Control Plane shared config
// Self-contained deploy cho HOME (DESKTOP-0L1K3A7). Mọi module trong control plane
// đọc config này, KHÔNG hardcode port/path. Deploy dir: C:\temp\home-cp\
// Core dùng chung được vendor tại .\core\ (bản sao browser-control-plane-core)
// để gói home-cp tự chứa, không ghi gì ngoài C:\temp\home-cp trên HOME.

export const cdpUrl =
  process.env.HOME_CP_CDP || 'http://127.0.0.1:9336'; // HOME không có Chrome CDP thường trực; chỉ sys.screenshot cần (xem README)

const baseDir = process.env.HOME_CP_DIR || 'C:\\temp\\home-cp';
export const deployDir = baseDir;

export const evidenceDir = process.env.HOME_CP_DIR ? path.join(baseDir, 'evidence') : 'C:\\temp\\home-cp\\evidence';

export const idempotencyFile = process.env.HOME_CP_DIR ? path.join(baseDir, 'idempotency.jsonl') : 'C:\\temp\\home-cp\\idempotency.jsonl';
