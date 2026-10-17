# Manual description and behavior judgment

CI automates structure, drift, and undisclosed-surface pre-checks. The semantic
verdict belongs to a human or designated judge, never to the script.
The automated `passes` applies only to its stated automated scope;
`description_matches_behavior` stays null until manual review.

Modeled on [Anthropic's policy verdict schema](https://github.com/anthropics/claude-plugins-official/blob/main/.github/policy/schema.json)
(`anthropics/claude-plugins-official .github/policy/schema.json`, read
2026-10-16). The manual verdict below uses its field names and types.
The CI pre-check instead records structured violations and explicit scope;
it is not a completed policy verdict.

## Inputs

Read the plugin's `.claude-plugin/plugin.json`, its marketplace entry in
`.claude-plugin/marketplace.json`, every `skills/*/SKILL.md`, the plugin
`README.md`, and every payload file, including hidden files, declared
components, executable code, configs, and hooks. Also read the canonical
runtime documentation and code for any behavior delegated to a local pack.

## Questions and evidence

Record an answer and evidence file for every question:

- List each claim in the description and its evidence file. Does actual
  behavior support the claim, including limitations and prerequisites?
- Which external network calls occur, to which hosts, for what purpose?
  Are the calls disclosed, including the local CDP connection and GitHub
  operations performed by the installed runtime?
- Is additional software downloaded? By which component and with what
  disclosure? Distinguish installation guidance from executed downloads.
- List every hook, its event and file references, whether it is gated by
  project relevance, and whether it accesses data beyond the stated scope.
  Unrestricted UserPromptSubmit, PreToolUse, or PostToolUse hooks require
  particular scrutiny.
- Is there undisclosed telemetry? Inspect imports, URLs, and outbound
  calls, including any required disclosure and opt-out.
- Does the data read or written match the described scope? Would a reader
  of the description be surprised by any data access or side effect?

## Verdict format

Replace the placeholders with the judge's findings. `passes` is true only
when the plugin is safe, has no broad-scope hooks or undisclosed telemetry,
and the description matches behavior. `violations` is a string citing
specific files/hooks and what was not disclosed, or empty when none.
Each hook string records event, path, gated/ungated, and network hosts.

```json
{
  "passes": false,
  "summary": "REPLACE_WITH_REVIEW_SUMMARY",
  "violations": "REPLACE_WITH_FINDINGS_OR_EMPTY_STRING",
  "may_make_external_network_calls": false,
  "may_download_additional_software": false,
  "hooks": [],
  "has_broad_scope_hooks": false,
  "has_undisclosed_telemetry": false,
  "description_matches_behavior": false,
  "claim_evidence": [
    {"claim": "REPLACE_WITH_EACH_DESCRIPTION_CLAIM", "file": "REPLACE_WITH_EVIDENCE_FILE"}
  ],
  "judge": "REPLACE_WITH_JUDGE_IDENTITY",
  "date": "YYYY-MM-DD",
  "commit": "REPLACE_WITH_REVIEWED_COMMIT"
}
```

## Gate rule and current status

A release/marketplace change is not DONE until a PASS verdict from this
checklist is recorded in the build/release record. Automated pre-checks
cannot supply or imply that verdict.

`github-cp v1.0.0`: **PENDING** (first run of this checklist happens at its
first release review).
