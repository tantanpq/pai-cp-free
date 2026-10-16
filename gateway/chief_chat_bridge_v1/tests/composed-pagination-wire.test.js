'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { createServer } = require('../src/server');
const {
  formatTypedOutwardResult,
  OUTWARD_CONTRACT_TYPES,
  OUTWARD_BUDGETS
} = require('../src/context-economy/typed-outward-contracts');

console.log('═══════════════════════════════════════════════════════════════');
console.log('  COMPOSED PAGINATION & TYPED OUTWARD CONTRACTS WIRE TEST');
console.log('═══════════════════════════════════════════════════════════════');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pai-composed-wire-'));
const spoolDir = path.join(root, 'spool');
fs.mkdirSync(spoolDir, { recursive: true });

const claimMockReader = {
  authority: () => ({
    status: 'OK',
    authority: {
      backend: 'POSTGRESQL',
      operationalCutover: true,
      generation: 118,
      fencingToken: 113,
      updatedAt: new Date().toISOString(),
      leaseExpiresAt: new Date(Date.now() + 120000).toISOString()
    }
  })
};

const app = createServer({
  env: {
    ...process.env,
    PAI_GATEWAY_CANARY: '1',
    PORT: '0',
    CHIEF_BRIDGE_DB_PATH: path.join(root, 'test.sqlite'),
    CHIEF_TASK_BOX_ROOT: path.join(root, 'task-box'),
    CHIEF_BRIDGE_USER_ID: 'tan',
    CHIEF_BRIDGE_PAI_ID: 'pai',
    CHIEF_BRIDGE_PROJECT_ID: 'PAI',
    CHIEF_MCP_PUBLIC_PROFILE: 'GOVERNED_RW'
  }
});
app.bridge.federationCore.realReaders = claimMockReader;

app.server.listen(0, '127.0.0.1', async () => {
  const port = app.server.address().port;

  const mcpCall = (name, args = {}) => new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/mcp',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'mcp-protocol-version': '2026-07-28'
      }
    }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`Failed to parse MCP response: ${body}`));
        }
      });
    });
    req.on('error', reject);
    req.end(JSON.stringify({
      jsonrpc: '2.0',
      id: Math.floor(Math.random() * 100000),
      method: 'tools/call',
      params: { name, arguments: args }
    }));
  });

  try {
    // ── Phase 1: Open Persistent Terminal Session over Wire ──
    console.log('\n── Phase 1: OPEN persistent terminal session over Wire ──');
    const openRes = await mcpCall('pai_action_run', {
      request_id: 'wire-test-open-1',
      intent: 'TERMINAL_COMMAND',
      effect_class: 'CANDIDATE_DRAFT',
      operation: 'OPEN'
    });

    assert.ok(openRes.result, 'Response must have result');
    const openData = openRes.result.structuredContent.result;
    assert.equal(openData.contract_type, OUTWARD_CONTRACT_TYPES.CONTROL_RECEIPT);
    const sessionId = openData.session_id;
    assert.ok(sessionId, 'Must return session_id');
    console.log(`✓ Terminal opened: session_id=${sessionId}, contract_type=${openData.contract_type}`);

    // ── Phase 2: Generate >= 1,000 Unicode Lines in Session ──
    console.log('\n── Phase 2: Execute command generating >= 1,000 Unicode lines ──');
    const totalLinesToGenerate = 1200;
    const generateScript = `1..${totalLinesToGenerate} | ForEach-Object { Write-Output "LINE-$($_): Tiếng Việt utf-8 kiểm tra 🚀 và 漢字 số $($_)" }`;

    const inputRes = await mcpCall('pai_action_run', {
      request_id: 'wire-test-input-1',
      session_id: sessionId,
      intent: 'TERMINAL_COMMAND',
      effect_class: 'CANDIDATE_DRAFT',
      operation: 'INPUT',
      input: generateScript
    });

    const inputData = inputRes.result.structuredContent.result;
    assert.equal(inputData.contract_type, OUTWARD_CONTRACT_TYPES.CONTROL_RECEIPT);
    const admittedBytes = inputData.next_cursor || inputData.nextCursor;
    assert.ok(admittedBytes > 0, `Output bytes must be > 0, got ${admittedBytes}`);
    console.log(`✓ Script executed, admitted total bytes: ${admittedBytes}`);

    // Locate the spool file on disk to get ground-truth bytes and SHA-256
    const session = app.bridge.federationCore.sessionRuntime.sessions.get(sessionId);
    assert.ok(session, 'Session must exist in runtime');
    const spoolPath = session.spooler?.spoolPath || path.join(os.tmpdir(), 'pai_terminal_spools', `${sessionId}.spool`);
    const groundTruthBytes = fs.readFileSync(spoolPath);
    const groundTruthHash = crypto.createHash('sha256').update(groundTruthBytes).digest('hex');
    console.log(`✓ Ground-truth spool size: ${groundTruthBytes.length} bytes, SHA256: ${groundTruthHash}`);

    // ── Phase 3: Sequential Wire Pagination Loop ──
    console.log('\n── Phase 3: Sequential wire pagination readback ──');
    let currentCursor = 0;
    let concatenatedChunks = Buffer.alloc(0);
    let chunkCount = 0;
    let hasMore = true;

    while (hasMore && currentCursor < groundTruthBytes.length) {
      chunkCount++;
      const readRes = await mcpCall('pai_action_run', {
        request_id: `wire-test-read-${chunkCount}`,
        session_id: sessionId,
        operation: 'READ',
        cursor: currentCursor,
        max_bytes: 4096,
        max_lines: 40
      });

      assert.ok(readRes.result, `Read call ${chunkCount} must have result`);
      const readData = readRes.result.structuredContent.result;

      // 1. Verify contract type
      assert.equal(readData.contract_type, OUTWARD_CONTRACT_TYPES.TERMINAL_READ_CHUNK);

      // 2. Verify chunk limits: <= 4KB AND <= 40 lines
      const chunkBuf = Buffer.from(readData.text, 'utf8');
      assert.ok(
        chunkBuf.length <= OUTWARD_BUDGETS.TERMINAL_READ_CHUNK.maxBytes,
        `Chunk bytes (${chunkBuf.length}) exceeds 4,096 ceiling`
      );

      const chunkLineCount = (readData.text.match(/\n/g) || []).length;
      assert.ok(
        chunkLineCount <= OUTWARD_BUDGETS.TERMINAL_READ_CHUNK.maxLines,
        `Chunk lines (${chunkLineCount}) exceeds 40 ceiling`
      );

      // 3. Verify monotonic cursor matching visible chunk bytes strictly
      assert.equal(readData.cursor, currentCursor, `Cursor mismatch on chunk ${chunkCount}`);
      assert.equal(
        readData.next_cursor,
        currentCursor + chunkBuf.length,
        `next_cursor (${readData.next_cursor}) must equal cursor (${currentCursor}) + visible_bytes (${chunkBuf.length})`
      );

      // 4. Accumulate delivered bytes
      concatenatedChunks = Buffer.concat([concatenatedChunks, chunkBuf]);
      currentCursor = readData.next_cursor;
      hasMore = readData.has_more;

      // Guard against infinite loop
      if (chunkCount > 200) {
        throw new Error('Pagination loop exceeded 200 iterations');
      }
    }

    console.log(`✓ Read completed in ${chunkCount} sequential chunks.`);
    console.log(`✓ Reassembled bytes: ${concatenatedChunks.length}, Ground-truth bytes: ${groundTruthBytes.length}`);

    // ── Phase 4: Zero Missing, Zero Duplicate, Hash Equivalence ──
    console.log('\n── Phase 4: Assert 0 missing, 0 duplicate, exact hash match ──');
    assert.equal(
      concatenatedChunks.length,
      groundTruthBytes.length,
      `Reassembled length (${concatenatedChunks.length}) must strictly match spool length (${groundTruthBytes.length})`
    );

    const reassembledHash = crypto.createHash('sha256').update(concatenatedChunks).digest('hex');
    assert.equal(
      reassembledHash,
      groundTruthHash,
      `Reassembled hash (${reassembledHash}) must strictly match ground-truth hash (${groundTruthHash})`
    );

    // Verify line count
    const totalDeliveredLines = concatenatedChunks.toString('utf8').split('\n').filter(l => l.trim().length > 0).length;
    assert.ok(
      totalDeliveredLines >= 1000,
      `Delivered lines (${totalDeliveredLines}) must be >= 1000`
    );
    console.log(`✓ 0 missing bytes, 0 duplicate bytes, strictly monotonic cursor.`);
    console.log(`✓ Reassembled SHA256 matches ground-truth spool: ${reassembledHash}`);
    console.log(`✓ Total delivered lines: ${totalDeliveredLines} >= 1000`);

    // ── Phase 5: Bounded fetch & exact content chunk ──
    console.log('\n── Phase 5: Test bounded fetch chunk ──');
    const fetchRes = await mcpCall('fetch', { id: 'jit:chief-resume', mode: 'FULL' });
    const fetchData = fetchRes.result.structuredContent;
    assert.equal(fetchData.contract_type, OUTWARD_CONTRACT_TYPES.EXACT_FETCH_CHUNK);
    const fetchSerializedBytes = Buffer.byteLength(JSON.stringify(fetchData), 'utf8');
    assert.ok(
      fetchSerializedBytes <= OUTWARD_BUDGETS.EXACT_FETCH_CHUNK.maxBytes,
      `Fetch response size (${fetchSerializedBytes}) exceeds 12KB ceiling`
    );
    console.log(`✓ Bounded fetch response verified: ${fetchSerializedBytes} bytes <= 12,288`);

    // ── Phase 6: HEAVY_ACTION_RESULT bounding ──
    console.log('\n── Phase 6: Test HEAVY_ACTION_RESULT bounding ──');
    const hugeActionOutput = {
      request_id: 'test-heavy-1',
      status: 'PASS',
      lifecycle_state: 'COMPLETED',
      transport: 'PAI_HOST_CONTROL',
      reason: 'Long build run with 500 lines of logs',
      giant_raw_log: 'X'.repeat(50000)
    };
    const heavyOutward = formatTypedOutwardResult({
      toolName: 'pai_action_run',
      input: { intent: 'BUILD', scope: 'PAI_CORE' },
      result: hugeActionOutput
    });
    assert.equal(heavyOutward.contract_type, OUTWARD_CONTRACT_TYPES.HEAVY_ACTION_RESULT);
    assert.equal(heavyOutward.raw_logs_external, true);
    const heavyBytes = Buffer.byteLength(JSON.stringify(heavyOutward), 'utf8');
    assert.ok(
      heavyBytes <= OUTWARD_BUDGETS.HEAVY_ACTION_RESULT.maxBytes,
      `Heavy action receipt size (${heavyBytes}) exceeds 1,843 byte ceiling`
    );
    console.log(`✓ Heavy action result bounded: ${heavyBytes} bytes <= 1,843 with raw logs external`);

    // ── Phase 7: Close Session ──
    console.log('\n── Phase 7: Close persistent session ──');
    const closeRes = await mcpCall('pai_action_run', {
      session_id: sessionId,
      operation: 'CLOSE'
    });
    const closeData = closeRes.result.structuredContent.result;
    assert.equal(closeData.contract_type, OUTWARD_CONTRACT_TYPES.CONTROL_RECEIPT);
    console.log('✓ Session closed cleanly');

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  COMPOSED PAGINATION WIRE INTEGRATION: ALL CHECKS PASS');
    console.log('═══════════════════════════════════════════════════════════════\n');

    app.server.close(() => {
      app.db.close();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      process.exit(0);
    });
  } catch (err) {
    console.error('FAILED:', err);
    app.server.close(() => {
      app.db.close();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      process.exit(1);
    });
  }
});
