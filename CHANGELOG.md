# Changelog

Changes are recorded in Keep a Changelog style.

## [Unreleased]

### Fixed

- Documentation only (no code changes), from the independent agent-first
  test and the house Assurance case run on 1.0.0:
  - `AGENT_INSTALL.md`: npm named as a hard prerequisite; concrete
    repository-identity check; install duration/stuck rule; after-install
    commands anchored to the clone root; `CDP_UNREACHABLE` troubleshooting
    with stop-and-report guidance; POSIX `<NAME>_CP_DIR` guidance.
  - `README.md`: chatgpt-cp is no longer described as a verified pack —
    9/10 flows verified, with the RB-12 case open and gating any sale.
  - `PACKAGE_MANIFEST.md`: corrected the rea-cp registry hash in section 1
    to the packaged bytes, and recorded the CP state-path default
    (Windows location) as a known limitation with the POSIX override.

## [1.0.0] - 2026-10-15

### Added

- Packaged core CP runner and free-tier planes: GitHub sample, REA, MSI, and HOME.
- Candidate-only seed kit and partial phase-1 MCP gateway.
- Doctor, quickstart, and install tooling, plus `AGENT_INSTALL.md`.
- `LICENSE`: PolyForm Shield 1.0.0.

### Fixed

- Seed executor-pin validation; the bundled suite now passes 9/9.
- Portability through environment-overridable paths and a bundled local browser lease.
- Doctor contract probes skip CPs omitted from the free repository and fail if none are present.

### Notes

- In the standalone gateway, the mind gate returns `MIND_GATE_NOT_CONFIGURED` metadata and does not enforce doctrine preflight for `chief_turn`.
- Memory rooms are absent: `chief_turn` receives null room context and `pai_get_context_pack` fails closed with `BLOCKED` / `MEMORY_ROOM_OWNER_UNAVAILABLE`.
- Behavioral memory is absent: `chief_turn` has no behavioral recall or capture, and status reports it unavailable.
- Prompt evidence is absent: prompt tools are not exposed and direct calls to them fail closed with `CHIEF_BRIDGE_DENIED`.
- `pai_resume` returns continuity metadata (degraded when its source is unavailable); it does not require these three services.
- Builder remains an unintegrated addon, offered separately from the free tier.
