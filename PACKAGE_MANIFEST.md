# PACKAGE MANIFEST — pai-cp

## Sellable pass - v1.0.0 (2026-10-15)

- **Seed suite:** fixed to **9/9**. Two deliberate divergences from upstream:
  executor-pin semantics and receipt-only seed validation, both fail-closed.
  See the gateway section below for the exact checks and historical result.
- **Portability:** environment-overridable CP config paths; bundled local
  browser lease fallback. `playwright-core` resolution order is
  `PLAYWRIGHT_CORE_PATH`, installed `playwright-core`, then the legacy
  local installation fallback.
- **Onboarding:** `package.json`, `install.mjs`, `AGENT_INSTALL.md`,
  `tools/doctor.mjs`, and `tools/quickstart.mjs`. Verified on Windows and
  Linux. On Windows (MSI host), the same tree passed doctor
  `PASS=6 WARN=0 FAIL=0`, `QUICKSTART OK`, and install verdict `ok:true`
  three times during this sellable pass (in-place x2 idempotent + one fresh
  tree). The Linux evidence is the clean-clone walkthrough.
- **Public docs:** README, QUICKSTART, CHANGELOG, and GitHub issue templates.
- **License:** PolyForm Shield 1.0.0, owner decision 2026-10-15;
  `LICENSE` is no longer a draft.

### Review fixes (2026-10-15)

- MAJOR 1: Lease steal/release use rename arbitration, raw-byte verification, and owner-preserving restoration. The bundled `lease-local` default TTL is 900s (15 minutes), the basis for AGENT_INSTALL.md's "leases expire in <= 15 min" line; the house lease module may use its own TTL.
- MAJOR 2: Legacy lease loading uses a file URL; a present but broken module fails closed, with injection and environment priority preserved.
- MAJOR 3: Seed field presence and types are validated before routing or replay lookup.
- MAJOR 4: Seeds require candidate-only drafts on CODEX_HOME and cannot use CLI failover or the host-control execution path.
- MINOR 5 RESOLVED (final): doctor contract probes require the genuine unknown-action payload (JSON ok:false with an 'unknown action:' error). Exit status is not used as the discriminator because CP runners exit 1 on any ok:false reply by design; module-load failures (e.g. 'Cannot find module') FAIL the probe. Verified: normal doctor PASS=6 WARN=0 FAIL=0; registry-override negative runs FAIL the probes.
- MINOR 6: Quickstart accepts only parsed signed-out observations with numeric counts and no challenge or watchdog error.
- MINOR 7: Quickstart tracks child lifetimes and kills owned trees on SIGINT/SIGTERM before exiting 130/143.
- MINOR 8: Gateway docs describe each stub accurately, including unenforced mind doctrine, blocked context packs, denied prompt tools, and degraded continuity metadata.
- MINOR 9: Builder docs scope historical qualification to the frozen house install and disclose that the portable package has not been re-qualified.

The seed suite remains 9/9. Deterministic lease races, five bundled lease
smoke checks, real house-lease loading, seed adversarial cases, real browser
observations, and signal-handler probes passed.
The standalone resume probe returned continuity metadata, rather than the
review's asserted denial, under both supported protocols; documentation
records the observed behavior. No historical Builder evidence was edited.

### External review - Grok (2026-10-15)

Verdict: **SELLABLE_WITH_FIXES**. The review reported 9 MAJOR + 5 MINOR
findings (R1-R14), all claim/evidence-discipline items about the review PACK
and docs; none concerned code behavior. Resolutions:

- R1: Windows-run evidence added to this manifest (fix round 4).
- R2: README per-pack verification wording qualified and browser-sample sentence corrected.
- R3: Section 1 github-cp catalog corrected to the shipped actions.
- R4: README limitations gained the RB-15 and home-cp drift bullets.
- R5: Packaged denylist word-boundary fact recorded (sections 1 and 7.7).
- R6: MINOR 5 note rewritten to the final resolution.
- R7: Task Box materialization evidence sentence added (section 2).
- R8: README Builder counts gained the not-re-qualified caveat.
- R9: Subset drill re-run on the final tree (see flip checklist).
- R10: Executor-pin paragraph tightened.
- R11: Lease TTL 900s fact recorded.
- R12: Section 7 pointer lines added.
- R13: TIERS update-window sentence qualified as a planned term.
- R14: Component rows' evidence basis stated in the section 1 preamble
  (2026-10-15 packaging survey); per-action execution evidence varies as annotated.

The parallel ChatGPT (Sol) review brief was placed in the house task box
on 2026-10-15. Live dispatch was blocked because the MSI ChatGPT session
was signed out, verified by `session.check` on both CDP ports. That review
remains pending a manual sign-in and is **NOT counted as received**.

### Post-v1.0.0 docs correction round (2026-10-15)

Documentation and manifest only — no code changed. Sources: the independent
agent-first test's 9 friction points (F1-F9) and the house Assurance case
run on v1.0.0 (findings A-1, A-2).

- **AGENT_INSTALL.md (F1-F9):** npm named as a hard prerequisite; concrete
  repository-identity check (`git remote get-url origin`); explicit section
  order and a hard separation between "install done = verdict `ok:true`"
  and the optional first action (which needs the user's signed-in Chrome);
  an install duration / stuck rule; after-install commands anchored to the
  clone root; `CDP_UNREACHABLE` added to the troubleshooting table with
  stop-and-report guidance; POSIX `<NAME>_CP_DIR` guidance (see section 7,
  item 9).
- **A-1 closed (claim-vs-artifact):** the README no longer describes
  chatgpt-cp as a "verified pack". Wording now states 9/10 flows verified
  with RB-12 open and gating any sale of that pack, consistently in the
  comparison section, the beyond-the-free-tier section, and the status
  table.
- **A-2 closed (evidence chain):** the section 1 rea-cp registry hash is
  corrected from `96b690f4…` to `3577d9aa78b0…`, the SHA-256 of the
  packaged `core/rea-cp/actions-rea/registry.mjs`. Every other section 1
  key-file prefix and all 30 full-hash rows in this manifest were
  recomputed against the packaged bytes in this round: no other mismatch.
- **Subset drill re-run** on the corrected tree: subset rebuilt with the
  INCLUDE paths (229 files); `node install.mjs` verdict `ok:true`;
  contract probes 4/4; `DOCTOR_RESULT PASS=6 WARN=0 FAIL=0`.
- The hash rows below for the files changed in this round (`README.md`,
  `AGENT_INSTALL.md`, `CHANGELOG.md`) are refreshed to the corrected bytes.

### PUBLIC SUBSET

The public repository is the FREE subset. Paid items are delivered
separately per order through private repository access or an archive.
The subset is defined by these paths, with directories included recursively:

**INCLUDE:**

- `README.md`, `QUICKSTART.md`, `AGENT_INSTALL.md`, `LICENSE`, `CHANGELOG.md`
- `PACKAGE_MANIFEST.md`, `package.json`, `package-lock.json`, `install.mjs`
- `.github/`
- `.claude-plugin/`, `plugins/` (added 2026-10-16 — Claude Code marketplace channel; distribution metadata + guidance only, pack runtime code stays single-sourced under `core/`)
- `core/browser-control-plane-core/`, `core/github-cp/`, `core/rea-cp/`
- `core/msi-cp/`, `core/home-cp/`
- `seed/`, `gateway/`, `tools/`

**EXCLUDE:**

- `core/chatgpt-cp/`, `core/grok-cp/`, `core/suno-cp/`
- `addons/`, `docs/`
- `TIERS.md`, `PRICING_DRAFT_INTERNAL.md`

**Marketplace addendum (2026-10-16):** the public subset also ships `.claude-plugin/marketplace.json` (marketplace slug `pai-cp`) and `plugins/github-cp/` (plugin slug `github-cp`). Slugs are immutable once published; renames go through the marketplace `renames` map. The plugin wrapper contains guidance only — no pack code copies.

The excluded tier/pricing files are internal drafts, not approved prices.

**Flip checklist:**

1. Construct the subset tree using only INCLUDE paths above.
2. Run `node install.mjs` in that tree; doctor probes skip absent CPs by design. DONE 2026-10-15 on the final tree: subset constructed with exactly the INCLUDE paths (229 files); `node install.mjs` verdict ok:true; contract-probes 4/4 present CPs; DOCTOR_RESULT PASS=6 WARN=0 FAIL=0; credential scan 0 hits (secret-looking assignments, Tailscale CGNAT IPs, personal emails). RE-RUN 2026-10-15 after the docs correction round, on the corrected tree: subset rebuilt at exactly 229 files; `node install.mjs` verdict ok:true in 49s; contract-probes 4/4; DOCTOR_RESULT PASS=6 WARN=0 FAIL=0.
3. Run a credential scan on the subset tree.
4. Flip only after the checks and a separate owner decision to make it public.

### Sellable-pass changed-file SHA-256

The original component table below has only a primitives hash entry among
these files; that prefix is refreshed there. Full current hashes for all
requested sellable-pass changes are recorded here. Other original hash
entries remain unchanged.

| File | SHA-256 |
| --- | --- |
| `gateway/chief_chat_bridge_v1/src/executor-router.js` | `11764a51f157ac62f6bc8204f0fcd6900462ae52968127afa69c2277543fe1e7` |
| `gateway/chief_chat_bridge_v1/src/federation-core.js` | `a179b3303b1bb22ed1da73be5dbaaecb79408e5de0f9dedb950d9d96dfa971e9` |
| `core/browser-control-plane-core/proto/operations.mjs` | `4d5fef41ffe166bfc941187090db015d0f21e171c5906e93065d174580a058ed` |
| `core/browser-control-plane-core/primitives/primitives.mjs` | `69c4ba1118b84e9ad722a7ebfe6aeed2951c0ec4598bce487769603bf52c1f65` |
| `core/browser-control-plane-core/observe-act/adapters/web.mjs` | `85faa75efa992cdceabeb6425e326b558f6dfa831359e9f4f83998b12d9d2311` |
| `core/chatgpt-cp/config.mjs` | `2f7fb4ffeb88064a7c07c72ddfb05f2119b647164758d68f352135573359aebd` |
| `core/github-cp/config.mjs` | `2f68264e6383ff6acf9de29c997a5bd38ba4cde6807c59ea21918e2e0b838cd6` |
| `core/grok-cp/config.mjs` | `8114ef4825268c57e7c3466f53e0d735d050b0fd6722df11471adb5dd102a6cc` |
| `core/home-cp/config.mjs` | `5c10bc60c7b436b3282122508334b43136424af5440436c002bbbd5bf3c61c1b` |
| `core/msi-cp/config.mjs` | `044b0072869512087c95ff1e9387ec52e667f03aaaa1b8635ad14d2595644c42` |
| `core/rea-cp/config.mjs` | `42d391460eee556c514f4c6f37f65f766e3f77123c2093ff088f3d276dd26c8c` |
| `core/suno-cp/config.mjs` | `4cc1dda532f3aea2ef381d434335b4c9b3c4ceefc30df43ce20a1ed46b18bd8f` |
| `README.md` | `c3d9a0379fe3a6844b49e695336585fc6358e035cbf1ce422b56c2caf441d6e7` |
| `addons/pai-cp-builder/README.md` | `32a857d3d1831e818e67d69c8a33ca8526e23c7b530365f4b56f532b06266fde` |
| `gateway/README.md` | `f3d15faefc9e75799853343a8d63c23d7819cd059110e64b71f54915c030ca93` |
| `tools/doctor.mjs` | `373782b45ce37b8daca8c11f519ba7c2983eaa0236d4e84d1b1f670a1c940279` |

### Brand-new sellable-pass files: SHA-256

| File | SHA-256 |
| --- | --- |
| `LICENSE` | `77421e050cf0d3d0842da4911875995b527c1ed27f9a6150cb03bdb9d84b861d` |
| `package.json` | `5399df2dbf8104dfd0280f3feef3540d79c271a4451991df7b608bbaac991f3b` |
| `package-lock.json` | `2bfbf4c0c426e150f7808efe2ecd6375d630538e3b4ebb0ca656368d3f6e1f38` |
| `install.mjs` | `92cc2e7fde51a421f68fb1303d03adc3ec27b4ff709c0ee3bf6650f6239033d4` |
| `AGENT_INSTALL.md` | `f0d256b8c2401dbb20fedfe0da9bb65f6c7f16ca528726771ed4206898a4dba2` |
| `QUICKSTART.md` | `37578d935dc470462b95daf3b949b25ce8a156e89d1de09fe8ded684adb0543c` |
| `CHANGELOG.md` | `5d0c7f6d2376cd48c3605a9fc4cfad458cd5c54eefd6d48078d48f4d44cb42de` |
| `TIERS.md` | `0c4c75fec07d8edad0836b679553106994971df942979e612c130584ccb5dce9` |
| `PRICING_DRAFT_INTERNAL.md` | `8c17290bfd539beb61f97ff40871f0fee0c0fa0ef96c6d3a2e0e3b84a212352b` |
| `core/browser-control-plane-core/proto/lease-local.mjs` | `20fe544a4b807d7b0d1180aa259c743282a286d503126e6ac33662e7e996643e` |
| `tools/quickstart.mjs` | `a1f3ded220cc84e86767227aa9192f2bfeea49c27b227be4263ccb6b4d411125` |
| `.github/ISSUE_TEMPLATE/bug_report.md` | `25e4cb3995cf94a22bd094c097bf7e7c6db064af18ed5e6b861e13a118ace653` |
| `.github/ISSUE_TEMPLATE/config.yml` | `13064e7bea658e01e718b414fbb7b3b244f36411fe25ee2055c151f7b534547a` |
| `.github/ISSUE_TEMPLATE/pack_breakage.md` | `80eae630ae445d2ab1f20c33a411531d8a8d1f989d570e79bd2c076f1837a1af` |

The following numbered sections preserve the original packaging record;
source/deployment comparisons describe that survey, with subsequent
sellable-pass changes recorded above and resolved defects annotated below.

- **Packaged:** 2026-10-15 · **Repo:** `tantanpq/pai-cp` (private)
- **Original package size:** 332 files · ~3.1 MB
- **Method:** every component surveyed file-by-file first (workspace source
  ↔ deployed copy compared by SHA-256 on the live machines, gateway read
  from upstream source, seed kit chosen by content hash across 110 Drive
  copies, Builder inventoried on both PCs). Survey:
  `docs/PAI_CP_PACKAGE_SURVEY_2026-10-15.md`.
- **Rule applied throughout:** where the deployed copy and the workspace
  source differ, the manifest says which one is in the package and why.
  Nothing was silently "cleaned up" — deviations are listed, not hidden.

## 1. core/

Original source workspace: the eight `*-control-plane` packages (no
`package.json` there at survey time — "version" below = SHA-256 prefix of
the key file + survey date). The package now includes a root `package.json`.
The component rows rest on the 2026-10-15 packaging survey's workspace-vs-deployment
hash verification (`PAI_CP_PACKAGE_SURVEY_2026-10-15`); execution evidence per
action varies by pack as annotated per row.

| Component | In package | Key file sha256 (12) | Status / known defects |
|---|---|---|---|
| `browser-control-plane-core` | Workspace shell (README, deploy script, `site.mjs`, `watch/evidence.mjs`) + **deployed code** for everything that had drifted | primitives `69c4ba1118b8` · runner `6d1c8188931f` | Deployed copy is the live truth and is NEWER: it alone has `proto/operations.mjs` and the 6-file **observe-act** layer (both included, from the deployment). `_backup-20261011/` excluded (stale backup). |
| `chatgpt-cp` | Workspace + deployed `actions-chatgpt/registry.mjs` and `watch/watchdog.mjs` | registry `c6b8c4ff3829` | 9/10 flows verified in the 2026-10-12 truth audit; **one resume-after-timeout case never verified (RB-12)**. Deployed registry is ~3.5 KB newer than workspace. |
| `github-cp` | Workspace, as-is | — | Code **identical** to deployment. Shipped actions: `session.check`, `issue.comment`, `issue.create`, `discussion.comment`; writes require an idempotency key. `issue.comment` has live-use evidence; `issue.create` and `discussion.comment` are implemented with the same postcondition verification but their live evidence is limited. **The login case was never confirmed (RB-15)**; `session.check` reports signed-out state honestly. |
| `msi-cp` | Workspace, as-is | — | Code **identical** to deployment. Most stable CP; also serves as the Builder's observer. (Its deployed dir also holds a vendored copy of the core primitives — carried once, in the core package.) |
| `grok-cp` | Workspace + deployed `actions-grok/registry.mjs` and `proto/run-action.mjs`; account email in the build doc replaced with a placeholder | registry `b106d9be0d7d` | Deployed code is newer (registry ~8 KB larger). **DOM selectors were never re-verified** in the truth audit — treat mappings as unproven until re-run. `rea-map-20261011.json` (a 477 KB REA scan artifact) excluded as a build artifact, not source. |
| `rea-cp` | Workspace (the original B1 source, **without** the Builder) | registry `3577d9aa78b0` (packaged `actions-rea/registry.mjs`) | REA is build-time web scanning → selector maps, read-only by design. The live deployment has the Builder wired into its registry — that wired copy lives in the Builder addon, not here. An earlier revision of this manifest recorded `96b690f4…` in this cell (a pre-packaging workspace-survey figure); that value does not verify against the packaged bytes and was corrected in the 2026-10-15 docs correction round below. |
| `suno-cp` | Workspace B1 source (5 code files) **plus** `deployed-pre-b1/` — a faithful snapshot of the code that actually runs on the MSI | B1 registry `bad92de4c431` · deployed run-action `9642d1ab76b2` | **The B1 modernization was never deployed** (no deploy script exists — audit RB-14): 0 files match between source and deployment; the deployment even lacks `config.mjs`. **`session.check` contradicts itself** (two gates, two answers — RB-11). Workspace dev probes (`proto/explore*.mjs`), the `reference/` folder and a backup tarball are excluded; the deployed snapshot carries its own probe set because that is what is actually installed. |
| `home-cp` | Workspace (minus `reviews/`) + `deployed-extensions/` with the code that exists only in the deployment | registry (workspace) `773ad4b5ffc6` · `PaiCpNative.cs` `c1db4958af10` | Richest CP (shell + Windows native API). Direction of drift is reversed here: the workspace registry is *larger* than the deployed one. The PACKAGED registry (`core/home-cp/actions-home/registry.mjs`, `EXEC_DENY` list) uses word-boundary (`\b`) regex matching throughout; this denylist style is present in the packaged bytes. The drift note concerns other differences; where any difference exists, the deployed behavior remains the operational truth. `deployed-extensions/` carries: `actions-home/run-ps-file.mjs`, `native-registry.mjs`, `native/` (backend, C# helper, resource lease, source manifest), `core/observe-act/` (Windows variant), `core/proto/operations.mjs`. **Excluded:** `native/config.json` — a per-session runtime binding (host name, window handle, PID), not source; `pai-terminal/` working dir (lane artifacts — the packaged terminal bridge cut from it is in `addons/pai-terminal-addon/`). |

Deploy scripts (`deploy*.sh`) are parameterized copies: target host/user
come from `CP_MSI_HOST`, `CP_MSI_USER`, `CP_HOME_HOST`, `CP_HOME_USER` and
the scripts fail loudly when they are unset. The originals in the source
workspace still carry the house values; only the packaged copies changed.

## 2. gateway/

Upstream: `pai-core-private` @ `7ccb92bf` (2026-10-13), folders
`src/one_pai/chief/CORE/{chief_chat_bridge_v1, chief_live_session_v1,
computer_execution_fabric_v1, role_jd_s0_v1}` + the prompt-evidence ledger
file from `06_STATE/`. Carried byte-identical except:

- `chief_chat_bridge_v1/src/server.js` — **not carried** (hard-requires 10
  sibling packages; embeds deployment-specific defaults and a fixed Drive
  catalog). Replaced by the new `gateway/server.standalone.cjs`
  (composition root, phase 1) — see `gateway/README.md` for the wired vs
  stubbed list. Headline: session store + all six federation tools
  (including `pai_action_run`) are real; mind gate / rooms / behavioral /
  prompt-evidence / accepted-composition are stubbed or null, and the
  prompt tools are therefore not public.
- Four parameterization patches (archive-root fallbacks ×2,
  executor-router CLI paths, host-control filesystem roots) — detailed in
  `gateway/README.md` §Patches.
- Two additional deliberate sellable-pass divergences from upstream:
  - **Executor-pin semantics:** a seed's HARD `executorConstraint` must
    match an eligible executor and never falls back; invalid seed input
    fails closed with `UNTRUSTED_SEED_EXECUTOR_CONSTRAINT`.
    Separately, a merely REGISTERED soft preference (no seed constraint)
    may still fall back under router policy; unknown preferred executor
    IDs/providers are refused with `PINNED_EXECUTOR_UNAVAILABLE`.
  - **Receipt-only seed validation:** when `seed_code` is absent, require
    the seed receipt schema, a 64-character lowercase hex fingerprint,
    `USER_PASTE_OR_LOCAL_APP_IMPORT` transport, and selected `CODEX_HOME`.
    With `seed_code`, decode it and require the receipt fingerprint to match.
    Invalid seed input fails with `UNTRUSTED_SEED_EXECUTOR_CONSTRAINT`;
    valid candidate-only seed probes stay no-effect. These seed validation
    checks fail closed.
- The ledger file sits in `gateway/vendor/prompt-evidence-ledger/`,
  carried for phase 2, not wired.

`federation-core` materializes Task Box items when a task box root is
configured (the `FederationCore.taskBoxRoot` path), which is the basis for
the README's "Task Box-backed delegation" wording; without a configured
root, no materialization occurs.

**Verification (2026-10-15, this packaging):** standalone boot smoke —
health/initialize/tools-list/`chief_status`/`pai_capabilities` all answer
for real; malformed `pai_action_run` fails closed with a receipt.
`test/seed-uplink.test.js`: **RESOLVED (2026-10-15)** - bundled suite **9/9**.
Executor-pin validation rejects unknown preferences and enforces hard constraints.
Seed validation checks receipt-only metadata or seed/fingerprint; invalid inputs fail closed; candidate-only probes stay no-effect.
Historical (was): **7/9 pass, identical to the pristine upstream clone**
(2 executor-pin failures pre-date packaging).
The bundled `tests/` suite targets the full PAI tree and is not runnable
in the phase-1 layout; it is carried as reference.

## 3. seed/

Canonical set chosen by content hash from 110 Drive copies (16 distinct
contents); byte-identical to the copies inside the gateway source.
Hashes (full) are in `seed/README.md`. Notes that matter: `seed.js` is a
Playwright module that only shares the name — kept, labelled, not part of
the kit functionally; `seed-compiler.cjs` is a different artifact and is
not included. Probe status at packaging time: R3 DONE/PASS · R2
RECOVERING/BLOCKED · R1 WAIT_RESOURCE/DEGRADED.

## 4. addons/pai-cp-builder/

**ADDON — UNDER DEVELOPMENT, not integrated into the core** (by the
owner's decision; development continues separately). Snapshot of R1 as
accepted 2026-10-14 (62/62 tests, 8 real operations, scoped QA
`QA_ACCEPTED_SCOPED`, Web-only). Runtime source hashes: `app-packs.mjs`
`de884c48426c…`, wired REA registry `3ebd979cb089…` — both match the live
MSI install and the R1 staging candidate byte-for-byte. Skill files match
across MSI, HOME and staging (4/4 hashes). Contents, declared dependencies
(core + observe-act pin + msi-cp observer) and the env configuration for
the parameterized client are documented in the addon's own README.
Not included: the 843,550-byte handover ZIP (sha256 `1b84df3d…` — its
inner skill copy holds the original hard-coded route; contents carried
extracted instead), the two installer ZIPs (contents = `installer/`),
live install evidence beyond the reduced acceptance set, and generated
packs/scans.

## 5. addons/pai-terminal-addon/

The v1 bundle as found packaged on the HOME PC; 7/7 files verified
against its own `MANIFEST.json` SHA-256 list at packaging time. Not
re-run for this repo. See its README.

## 6. Hygiene record

Sweeps run over everything packaged (workspace sources, deployed files
pulled read-only from both PCs, gateway upstream source, seed copies,
Builder staging):

- **Credential material: none found, none included.** No token/key
  literals, no credential prefixes, no session/storage-state artifacts,
  no cookies. (Keyword hits for "token"/"cookie" in code are logic, not
  values.)
- **Personal email:** 1 occurrence (grok build doc) → placeholder.
- **Machine IPs (Tailscale):** in deploy scripts + Builder client →
  parameterized (env, fail-closed). None remain in the package.
- **User-profile paths:** parameterized in gateway runtime files and the
  Builder client/installer-test; replaced with `<user>` in Builder
  evidence JSON copies (originals untouched); gateway test fixtures keep
  theirs (labelled as fixtures in `gateway/README.md`).
- **Runtime data excluded everywhere:** CP evidence folders, run outputs,
  session stores, install work dirs (~30k files on the HOME deployment
  alone) — the package contains source, docs and reduced acceptance
  evidence only.
- Code changes in the original packaging (composition root, 4 gateway
  patches, Builder client + installer-test parameterization, deploy-script
  parameterization) went through independent Codex review (3 rounds,
  2026-10-15): the four patch sets were CLEAN in round 1; three findings
  on the new/parameterized code (a malformed-body crash path and a
  Windows case-alias bypass of the canary DB isolation in
  `server.standalone.cjs`, an unquoted remote path in the Builder client)
  were fixed and re-confirmed fixed in rounds 2–3. What Codex could not
  inspect (bridge internals behind the null/stub wiring) is covered by the
  packager's live boot smoke in §2. Pure copies are hash-verified instead.

## 7. Known-defects summary (nothing here is hidden)

(Also disclosed earlier in this manifest: seed live-probe states R3 DONE/PASS,
R2 RECOVERING/BLOCKED, R1 WAIT_RESOURCE/DEGRADED - section 3; and the gateway
`tests/` suite carried as reference, not runnable in the phase-1 layout - section 2.)

1. `suno-cp`: B1 source never deployed; `session.check` self-contradictory.
2. `grok-cp`: selectors unverified since the audit.
3. `github-cp`: login case unconfirmed.
4. `chatgpt-cp`: one resume-after-timeout case unverified.
5. Gateway: phase-1 composition only; seed executor-pin defect
   **RESOLVED (2026-10-15)** - bundled seed suite **9/9**.
   Fix: validate unknown executor preferences and enforce hard seed constraints.
   Fix: validate receipt-only metadata or seed/fingerprint; invalid inputs fail closed.
   Historical (was): upstream seed test has 2 pre-existing failures in the
   executor-pin path (present in the pristine upstream clone too).
6. Builder: Web-only; native/3D unaccepted; generated packs remain
   CANDIDATE until their target workflow is run for real.
7. `home-cp`: workspace ↔ deployment drift runs in both directions.
   The PACKAGED registry (`core/home-cp/actions-home/registry.mjs`,
   `EXEC_DENY` list) uses word-boundary (`\b`) regex matching throughout;
   this denylist style is present in the packaged bytes. The drift note
   concerns other differences; where any difference exists, the deployed
   behavior remains the operational truth.
8. Gateway v1 does not strictly enforce per-tool argument schemas
   (additionalProperties are not enforced; an unknown extra property does
   not block execution). Mitigations: `READ_ONLY` profile for untrusted
   callers; executor binaries overridable via `PAI_AGY_CLI_PATH` /
   `PAI_GROK_CLI_PATH`; the quickstart smoke neutralizes executors by design.
   Unknown-tool refusal (`BRIDGE_TOOL_DENIED`) is enforced.
9. CP state paths default to Windows locations: without `<NAME>_CP_DIR`,
   each CP's evidence directory and idempotency file resolve to
   `C:\temp\<name>-cp\...` — on Linux/macOS that string becomes a literal
   relative path under the working directory and dirties a clone used as
   the working directory (found by the independent agent-first test, F7).
   Installation is unaffected; set `<NAME>_CP_DIR` per CP to a POSIX path
   before running actions, e.g. `export GITHUB_CP_DIR="$HOME/.pai-cp/github-cp"`.
