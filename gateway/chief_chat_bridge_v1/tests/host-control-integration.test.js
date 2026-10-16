'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// HOST_CONTROL Integration Test Suite
// Tests: adapter, allow/deny, authority, timeout, idempotency, security, canaries
// ═══════════════════════════════════════════════════════════════════════════

const path = require('node:path');
const fs = require('node:fs');

// Resolve relative to CORE/chief_chat_bridge_v1/src
const srcDir = path.resolve(__dirname, '..', 'src');
const {
  GovernedHostControlAdapter,
  HOST_CONTROL_INTENTS,
  matchesDenyList,
  matchesAllowList,
  classifyAuthorityClass,
  isPathWithinRoots,
  COMMAND_ALLOW_LIST_CLASS_A,
  COMMAND_DENY_LIST,
  ALLOWED_READ_ROOTS,
  ALLOWED_WRITE_ROOTS,
  EVIDENCE_DIR
} = require(path.join(srcDir, 'host-control-adapter'));

const { resolveTargetHost, getHostCapabilities } = require(path.join(srcDir, 'host-capability-resolver'));
const { HOST_CONTROL_AUTHORITY_POLICY, HOST_CONTROL_INTENTS: ROUTER_INTENTS, classifyHostControlAuthority } = require(path.join(srcDir, 'executor-router'));
const { MINIMAL_TOOL_PROFILES, INTENT_TO_PROFILE, resolveToolProfile } = require(path.join(srcDir, 'tool-profile-resolver'));

let passed = 0;
let failed = 0;
const results = [];

function assert(condition, name) {
  if (condition) {
    passed++;
    results.push({ name, status: 'PASS' });
  } else {
    failed++;
    results.push({ name, status: 'FAIL' });
    console.error(`  FAIL: ${name}`);
  }
}

async function assertRejects(fn, code, name) {
  try {
    await fn();
    failed++;
    results.push({ name, status: 'FAIL', reason: 'Did not throw' });
    console.error(`  FAIL: ${name} (did not throw)`);
  } catch (err) {
    const matches = err.message.includes(code) || (err.code && err.code.includes(code));
    if (matches) {
      passed++;
      results.push({ name, status: 'PASS' });
    } else {
      failed++;
      results.push({ name, status: 'FAIL', reason: `Wrong error: ${err.message}` });
      console.error(`  FAIL: ${name} (got: ${err.message}, expected: ${code})`);
    }
  }
}

async function run() {
  console.log('═══ HOST_CONTROL Integration Tests ═══\n');

  // ── 1. Unit Tests: Authority Classification ──────────────────────────
  console.log('── Authority Classification ──');
  assert(classifyAuthorityClass('HOST_INSPECT', 'NO_MATERIAL_DELTA') === 'A', 'Class A: HOST_INSPECT + NO_MATERIAL_DELTA');
  assert(classifyAuthorityClass('HOST_INSPECT', 'READ_ONLY') === 'A', 'Class A: HOST_INSPECT + READ_ONLY');
  assert(classifyAuthorityClass('FILESYSTEM_READ', 'READ_ONLY') === 'A', 'Class A: FILESYSTEM_READ');
  assert(classifyAuthorityClass('FILESYSTEM_EDIT', 'CANDIDATE_DRAFT') === 'B', 'Class B: FILESYSTEM_EDIT + CANDIDATE_DRAFT');
  assert(classifyAuthorityClass('TERMINAL_COMMAND', 'CANDIDATE_DRAFT') === 'B', 'Class B: TERMINAL_COMMAND + CANDIDATE_DRAFT');
  assert(classifyAuthorityClass('SERVICE_CONTROL', 'REVERSIBLE_LOCAL_EFFECT') === 'C', 'Class C: SERVICE_CONTROL');
  assert(classifyAuthorityClass('PROCESS_CONTROL', 'REVERSIBLE_LOCAL_EFFECT') === 'C', 'Class C: PROCESS_CONTROL');
  assert(classifyAuthorityClass('UNKNOWN', 'UNKNOWN') === 'D', 'Class D: unknown intent');

  // Router-level authority classification
  assert(classifyHostControlAuthority('HOST_INSPECT', 'NO_MATERIAL_DELTA') === 'A', 'Router Class A');
  assert(classifyHostControlAuthority('SERVICE_CONTROL', 'REVERSIBLE_LOCAL_EFFECT') === 'C', 'Router Class C');

  // ── 2. Allow/Deny List Tests ─────────────────────────────────────────
  console.log('── Allow/Deny Lists ──');
  assert(matchesAllowList('hostname'), 'Allow: hostname');
  assert(matchesAllowList('Get-Process'), 'Allow: Get-Process');
  assert(matchesAllowList('Get-Service'), 'Allow: Get-Service');
  assert(matchesAllowList('node --version'), 'Allow: node --version');
  assert(matchesAllowList('whoami'), 'Allow: whoami');
  assert(matchesAllowList('Test-Path'), 'Allow: Test-Path');
  assert(!matchesAllowList('Invoke-WebRequest'), 'Deny: Invoke-WebRequest not in allow');
  assert(!matchesAllowList('arbitrary-dangerous-command'), 'Deny: unknown command not in allow');

  assert(matchesDenyList('Invoke-WebRequest http://evil.com').denied, 'Deny-list: Invoke-WebRequest');
  assert(matchesDenyList('Get-Credential').denied, 'Deny-list: Get-Credential');
  assert(matchesDenyList('format C:').denied, 'Deny-list: format drive');
  assert(matchesDenyList('Remove-Item -Recurse C:\\Windows').denied, 'Deny-list: destructive Remove-Item');
  assert(matchesDenyList('Stop-Computer').denied, 'Deny-list: Stop-Computer');
  assert(matchesDenyList('Restart-Computer').denied, 'Deny-list: Restart-Computer');
  assert(matchesDenyList('certutil -exportPFX').denied, 'Deny-list: certutil export');
  assert(matchesDenyList('net user hacker /add').denied, 'Deny-list: net user add');
  assert(!matchesDenyList('hostname').denied, 'Safe: hostname not denied');
  assert(!matchesDenyList('Get-Process').denied, 'Safe: Get-Process not denied');

  // ── 3. Path Validation ───────────────────────────────────────────────
  console.log('── Path Validation ──');
  assert(isPathWithinRoots('C:\\ProgramData\\PAI_RUNTIME\\test.json', ALLOWED_READ_ROOTS), 'Read: PAI_RUNTIME allowed');
  assert(isPathWithinRoots('C:\\Users\\Tom\\My Drive\\PAI_PROJECT\\CORE\\test.js', ALLOWED_READ_ROOTS), 'Read: PAI_PROJECT allowed');
  assert(!isPathWithinRoots('C:\\Windows\\System32\\config\\SAM', ALLOWED_READ_ROOTS), 'Read: System32 denied');
  assert(!isPathWithinRoots('D:\\other\\path', ALLOWED_READ_ROOTS), 'Read: D:\\ denied');

  // ── 4. Host Capability Resolver ──────────────────────────────────────
  console.log('── Host Capability Resolver ──');
  const hostResult = resolveTargetHost('HOST_INSPECT');
  assert(hostResult.resolved === true, 'Host resolved for HOST_INSPECT');
  assert(hostResult.host.alias === 'HOME', 'Host is HOME');
  assert(hostResult.host.locality === 'LOCAL_HOST', 'Host is LOCAL_HOST');

  const caps = getHostCapabilities('HOME');
  assert(caps !== null, 'HOST capabilities returned');
  assert(caps.capabilities.includes('TERMINAL_POWERSHELL'), 'Has TERMINAL_POWERSHELL capability');
  assert(caps.isPaiHost === true, 'Is PAI host');

  // ── 5. JIT Profile Resolution ────────────────────────────────────────
  console.log('── JIT Profile Resolution ──');
  assert(MINIMAL_TOOL_PROFILES.HOST_CONTROL !== undefined, 'HOST_CONTROL profile exists');
  assert(MINIMAL_TOOL_PROFILES.HOST_CONTROL.tools.length <= 8, 'HOST_CONTROL tools <= 8');
  assert(MINIMAL_TOOL_PROFILES.HOST_CONTROL.tools.includes('pai_action_run'), 'HOST_CONTROL includes pai_action_run');

  assert(INTENT_TO_PROFILE.HOST_INSPECT === 'HOST_CONTROL', 'HOST_INSPECT maps to HOST_CONTROL');
  assert(INTENT_TO_PROFILE.TERMINAL_COMMAND === 'HOST_CONTROL', 'TERMINAL_COMMAND maps to HOST_CONTROL');
  assert(INTENT_TO_PROFILE.SERVICE_CONTROL === 'HOST_CONTROL', 'SERVICE_CONTROL maps to HOST_CONTROL');

  // Profile resolution
  const profile = resolveToolProfile({ intentClass: 'HOST_INSPECT' }, []);
  assert(profile.profileId === 'HOST_CONTROL', 'resolveToolProfile returns HOST_CONTROL for HOST_INSPECT');

  // BOOT profile unchanged
  const boot = resolveToolProfile({ intentClass: 'BOOT' }, []);
  assert(boot.profileId === 'BOOT_DISCOVERY', 'BOOT still resolves to BOOT_DISCOVERY');
  assert(boot.toolNames.length <= 8, 'BOOT tools <= 8');

  // ── 6. Adapter Execution: Canary 1 — hostname ───────────────────────
  console.log('── Canary 1: hostname ──');
  const adapter = new GovernedHostControlAdapter();
  const hostnameResult = await adapter.execute({
    request_id: 'canary-hostname-001',
    intent: 'HOST_INSPECT',
    objective: 'hostname',
    effect_class: 'NO_MATERIAL_DELTA'
  });
  assert(hostnameResult.status === 'SUCCESS', 'Canary 1: hostname SUCCESS');
  assert(hostnameResult.exit_code === 0, 'Canary 1: exit_code 0');
  assert(hostnameResult.host === 'HOME', 'Canary 1: host = HOME');
  assert(hostnameResult.rdc_dependency === false, 'Canary 1: no RDC');
  assert(hostnameResult.transport === 'PAI_HOST_CONTROL', 'Canary 1: transport = PAI_HOST_CONTROL');
  assert(hostnameResult.authority_class === 'A', 'Canary 1: authority class A');
  assert(hostnameResult.key_output.length > 0, 'Canary 1: has key_output');
  console.log(`  hostname = ${hostnameResult.key_output.trim()}`);

  // ── 7. Canary 2: process inspect ────────────────────────────────────
  console.log('── Canary 2: process inspect ──');
  const processResult = await adapter.execute({
    request_id: 'canary-process-001',
    intent: 'HOST_INSPECT',
    objective: 'Get-Process node -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,StartTime | Format-Table -AutoSize | Out-String',
    effect_class: 'NO_MATERIAL_DELTA'
  });
  assert(processResult.status === 'SUCCESS', 'Canary 2: process inspect SUCCESS');
  assert(processResult.exit_code === 0, 'Canary 2: exit_code 0');
  assert(processResult.rdc_dependency === false, 'Canary 2: no RDC');
  assert(processResult.key_output.length > 0, 'Canary 2: has process output');
  // Output should not be massive
  assert(processResult.key_output.length < 8192, 'Canary 2: output bounded');

  // ── 8. Canary 3: harmless command (node --version) ──────────────────
  console.log('── Canary 3: node --version ──');
  const nodeResult = await adapter.execute({
    request_id: 'canary-node-version-001',
    intent: 'TERMINAL_COMMAND',
    objective: 'node --version',
    effect_class: 'NO_MATERIAL_DELTA'
  });
  assert(nodeResult.status === 'SUCCESS', 'Canary 3: node --version SUCCESS');
  assert(nodeResult.exit_code === 0, 'Canary 3: exit_code 0');
  assert(nodeResult.key_output.startsWith('v'), 'Canary 3: output starts with v');
  console.log(`  node version = ${nodeResult.key_output.trim()}`);

  // ── 9. Canary 4: reversible filesystem ──────────────────────────────
  console.log('── Canary 4: reversible filesystem ──');
  const tempDir = EVIDENCE_DIR;
  const testFile = path.join(tempDir, 'canary_test_file.txt');
  const testContent = `CANARY_TEST_${Date.now()}`;

  // Write
  const writeResult = await adapter.execute({
    request_id: 'canary-fs-write-001',
    intent: 'FILESYSTEM_EDIT',
    objective: `Set-Content -Path '${testFile.replace(/'/g, "''")}' -Value '${testContent}'`,
    effect_class: 'CANDIDATE_DRAFT',
    scope: tempDir,
    target_path: testFile
  });
  assert(writeResult.status === 'SUCCESS', 'Canary 4: write SUCCESS');

  // Read back
  const readResult = await adapter.execute({
    request_id: 'canary-fs-read-001',
    intent: 'FILESYSTEM_READ',
    objective: `Get-Content -Path '${testFile.replace(/'/g, "''")}'`,
    effect_class: 'READ_ONLY',
    target_path: testFile
  });
  assert(readResult.status === 'SUCCESS', 'Canary 4: read SUCCESS');
  assert(readResult.key_output.trim() === testContent, 'Canary 4: content matches');

  // Verify hash
  const hashResult = await adapter.execute({
    request_id: 'canary-fs-hash-001',
    intent: 'HOST_INSPECT',
    objective: `Get-FileHash -Path '${testFile.replace(/'/g, "''")}' -Algorithm SHA256 | Select-Object -ExpandProperty Hash`,
    effect_class: 'NO_MATERIAL_DELTA'
  });
  assert(hashResult.status === 'SUCCESS', 'Canary 4: hash SUCCESS');
  assert(hashResult.key_output.length > 0, 'Canary 4: hash returned');

  // Cleanup
  const cleanupResult = await adapter.execute({
    request_id: 'canary-fs-cleanup-001',
    intent: 'FILESYSTEM_EDIT',
    objective: `Remove-Item -Path '${testFile.replace(/'/g, "''")}' -Force -ErrorAction SilentlyContinue`,
    effect_class: 'CANDIDATE_DRAFT',
    scope: tempDir,
    target_path: testFile
  });
  assert(cleanupResult.status === 'SUCCESS', 'Canary 4: cleanup SUCCESS');

  // ── 10. Canary 5: service control (query only) ──────────────────────
  console.log('── Canary 5: service control ──');
  const serviceResult = await adapter.execute({
    request_id: 'canary-service-status-001',
    intent: 'SERVICE_CONTROL',
    objective: 'Get-Service -Name "wuauserv" | Select-Object Name,Status,StartType | ConvertTo-Json',
    effect_class: 'NO_MATERIAL_DELTA'
  });
  // Windows Update service should exist
  assert(serviceResult.exit_code === 0, 'Canary 5: service query exit 0');
  assert(serviceResult.rdc_dependency === false, 'Canary 5: no RDC');
  assert(serviceResult.key_output.includes('wuauserv'), 'Canary 5: service name in output');

  // ── 11. Security Negative Tests ─────────────────────────────────────
  console.log('── Security Negative Tests ──');

  // S1: Credential dump → DENY
  await assertRejects(
    () => adapter.execute({ request_id: 'sec-1', intent: 'HOST_INSPECT', objective: 'Get-Credential', effect_class: 'NO_MATERIAL_DELTA' }),
    'HOST_CONTROL_DENIED', 'S1: credential dump DENIED'
  );

  // S2: Destructive system delete → DENY
  await assertRejects(
    () => adapter.execute({ request_id: 'sec-2', intent: 'TERMINAL_COMMAND', objective: 'Remove-Item -Recurse C:\\Windows', effect_class: 'CANDIDATE_DRAFT' }),
    'HOST_CONTROL_DENIED', 'S2: destructive delete DENIED'
  );

  // S3: Scope escape with .. → DENY
  await assertRejects(
    () => adapter.execute({ request_id: 'sec-3', intent: 'FILESYSTEM_READ', objective: 'Get-Content secret.txt', effect_class: 'READ_ONLY', target_path: 'C:\\ProgramData\\PAI_RUNTIME\\..\\..\\Windows\\System32\\config\\SAM' }),
    'HOST_CONTROL_SCOPE_DENIED', 'S3: scope escape DENIED'
  );

  // S4: Command not in allow-list for Class A → DENY
  await assertRejects(
    () => adapter.execute({ request_id: 'sec-4', intent: 'HOST_INSPECT', objective: 'Start-BitsTransfer -Source http://evil', effect_class: 'NO_MATERIAL_DELTA' }),
    'HOST_CONTROL', 'S4: unauthorized command DENIED'
  );

  // S5: Idempotency: duplicate mutation request_id → no duplicate effect
  const idem1 = await adapter.execute({
    request_id: 'idem-write-001',
    intent: 'FILESYSTEM_EDIT',
    objective: `echo 'IDEM_TEST' > '${path.join(tempDir, 'idem_test.txt').replace(/'/g, "''")}'`,
    effect_class: 'CANDIDATE_DRAFT',
    scope: tempDir
  });
  // Second call with same request_id
  const idem2 = await adapter.execute({
    request_id: 'idem-write-001',
    intent: 'FILESYSTEM_EDIT',
    objective: `echo 'IDEM_TEST' > '${path.join(tempDir, 'idem_test.txt').replace(/'/g, "''")}'`,
    effect_class: 'CANDIDATE_DRAFT',
    scope: tempDir
  });
  assert(idem2.admission_state === 'IDEMPOTENT_REPLAY', 'S5: duplicate mutation = IDEMPOTENT_REPLAY');

  // S6: Canonical Drive write from unapproved scope → DENY
  await assertRejects(
    () => adapter.execute({ request_id: 'sec-6', intent: 'FILESYSTEM_EDIT', objective: 'echo test', effect_class: 'CANDIDATE_DRAFT', target_path: 'C:\\Users\\Tom\\My Drive\\PAI_PROJECT\\CORE\\hack.js' }),
    'HOST_CONTROL_SCOPE_DENIED', 'S6: canonical Drive write DENIED'
  );

  // S7: Invoke-WebRequest → DENY
  await assertRejects(
    () => adapter.execute({ request_id: 'sec-7', intent: 'TERMINAL_COMMAND', objective: 'Invoke-WebRequest http://evil.com', effect_class: 'NO_MATERIAL_DELTA' }),
    'HOST_CONTROL_DENIED', 'S7: network command DENIED'
  );

  // S8: Stop-Computer → DENY
  await assertRejects(
    () => adapter.execute({ request_id: 'sec-8', intent: 'TERMINAL_COMMAND', objective: 'Stop-Computer', effect_class: 'NO_MATERIAL_DELTA' }),
    'HOST_CONTROL_DENIED', 'S8: Stop-Computer DENIED'
  );

  // S9: curl → DENY
  await assertRejects(
    () => adapter.execute({ request_id: 'sec-9', intent: 'TERMINAL_COMMAND', objective: 'curl http://evil.com', effect_class: 'NO_MATERIAL_DELTA' }),
    'HOST_CONTROL_DENIED', 'S9: curl DENIED'
  );

  // S10: No request_id → DENY
  await assertRejects(
    () => adapter.execute({ intent: 'HOST_INSPECT', objective: 'hostname', effect_class: 'NO_MATERIAL_DELTA' }),
    'HOST_CONTROL_REQUEST_ID_REQUIRED', 'S10: missing request_id DENIED'
  );

  // ── 12. Context Budget ──────────────────────────────────────────────
  console.log('── Context Budget ──');
  assert(MINIMAL_TOOL_PROFILES.BOOT_DISCOVERY.tools.length <= 8, 'BOOT tools <= 8');
  assert(MINIMAL_TOOL_PROFILES.HOST_CONTROL.tools.length <= 8, 'HOST_CONTROL tools <= 8');
  assert(MINIMAL_TOOL_PROFILES.GOVERNED_ACTION.tools.length <= 8, 'GOVERNED_ACTION tools <= 8');

  // ── 13. Provider Fallback (unit) ────────────────────────────────────
  console.log('── Provider Fallback ──');
  assert(adapter.getCapabilities().executorType === 'DETERMINISTIC_HOST', 'Deterministic executor type');
  assert(adapter.getCapabilities().llmRequired === false, 'No LLM required for simple commands');

  // ── 14. No-RDC Proof ───────────────────────────────────────────────
  console.log('── No-RDC Proof ──');
  assert(hostnameResult.transport === 'PAI_HOST_CONTROL', 'Transport = PAI_HOST_CONTROL');
  assert(hostnameResult.rdc_dependency === false, 'rdc_dependency = false');
  assert(processResult.rdc_dependency === false, 'Process inspect: no RDC');
  assert(nodeResult.rdc_dependency === false, 'Node version: no RDC');

  // ═══ Summary ═══════════════════════════════════════════════════════
  console.log(`\n═══ Results: ${passed} PASSED, ${failed} FAILED ═══`);

  // Write receipt
  const receipt = {
    test_suite: 'HOST_CONTROL_INTEGRATION_TESTS',
    timestamp: new Date().toISOString(),
    passed,
    failed,
    total: passed + failed,
    verdict: failed === 0 ? 'PASS' : 'FAIL',
    results: results.map(r => `${r.status}: ${r.name}`),
    canaries: {
      hostname: hostnameResult.status,
      process_inspect: processResult.status,
      node_version: nodeResult.status,
      filesystem: writeResult.status,
      service_query: serviceResult.status
    },
    no_rdc: true,
    transport: 'PAI_HOST_CONTROL'
  };

  const receiptPath = path.join(EVIDENCE_DIR, 'HOST_CONTROL_TEST_RECEIPT.json');
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
  console.log(`Receipt: ${receiptPath}`);

  process.exit(failed === 0 ? 0 : 1);
}

run().catch(err => {
  console.error('FATAL:', err);
  process.exit(2);
});
