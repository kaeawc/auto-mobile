---
description: Hunt or fix a device session lifecycle bug (startDevice, session UUIDs, boot readiness, shutdown, daemon, pool/session races) using the accumulated bug history and invariants.
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, Task, WebFetch, Skill
argument-hint: [issue # | symptom description | "audit <area>"] (optional)
---

Load and follow the `device-session-lifecycle` skill
(`skills/device-session-lifecycle/SKILL.md`) — it is the source of truth for
the identifiers, invariants, recurring bug classes, weak-spot map, and test
discipline. Its `references/history.md` catalogs every past lifecycle
issue/PR by era and bug class.

## Input

`$ARGUMENTS` is one of:
- **An issue number** — read it with `gh issue view`, classify the symptom
  against the skill's bug classes, check the history catalog for a prior
  instance, then hunt per the skill's procedure (§4).
- **A symptom description** — same, starting from the identifier
  classification step (§1): which of the four identifiers is involved?
- **`audit <area>`** (e.g. `audit shutdown`, `audit registry retire paths`)
  — sweep the named area's weak spots (§6) for violations of the invariants
  (§2), following the audit style of Era 4 (coded findings, one issue per
  confirmed defect).
- Empty — ask what to hunt, offering the open threads listed at the end of
  the skill as candidates.

## Rules

- Before diagnosing, rule out the documented environment artifacts (skill
  §4.2): daemon-restart transport wedge, multi-worktree daemon churn,
  DisconnectMonitor auto-restart, stale dist behind a fresh version string.
- Ground every claim in adb/simctl/process-table/daemon-log evidence, never
  a tool's `success` flag.
- A fix is not done until a unit test forces the exact interleaving via the
  injected seams (FakeTimer/FakeIdGenerator/fakes), and — for anything
  touching pool runtime identity or streaming — a live-emulator or
  stream-subscriber check has run (skill §7 blind spots).
- File issues / open PRs per repo conventions (`skills/ship-issue`,
  `skills/push-pr`) when the user asks for fixes to land.
