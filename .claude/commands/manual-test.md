---
description: Run an AutoMobile manual-test iteration from a start point — rebuild all components, restart the daemon, and verify closed issues / merged PRs on current HEAD against a real Android emulator and iOS simulator.
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, Task, WebFetch, Skill
argument-hint: [commit | tag/milestone | date] (optional; will ask if omitted)
---

Run one AutoMobile manual-test iteration. **Load and follow the
`manual-test` skill (`skills/manual-test/SKILL.md`) — it is the
source of truth** for the procedure and the hard-won gotchas; this command only
sets up the inputs.

## Start point

`$ARGUMENTS` is the starting point to test forward from — a commit SHA, a git
tag/milestone, or a date. If it is empty, **ask** the user for one before doing
anything else (offer the latest release tag as the default:
`git tag | sort -V | tail -3`). Resolve it to a git ref and a date, then compute
the range `<START>..origin/main`.

## What to do

Execute the skill's phases in order:

1. **Scope** — enumerate merged PRs and closed issues since `<START>`, classify
   each as bug-fix (reproduce → confirm fixed) or feature/spec (exercise → confirm
   delivered), and map the changed `src/` surface to affected MCP tools. Present the
   checklist.
2. **Rebuild ALL necessary components** — rebase + fast-forward the daemon's main
   checkout; `bun run build` + regenerate schemas; rebuild the **Android ctrlproxy
   APK** if `android/control-proxy/**` changed and the **iOS runner** if
   `ios/control-proxy/**` changed; rebuild the playground SDK app only if testing SDK
   features (standard gradle output, not the grit/gojvm variants). Never trust the
   daemon version string — verify by build hash / dist mtime.
3. **Restart the daemon** with exactly the flags this run needs (`--embedded-sdk`,
   `--network-mockable`, APK/iOS runner overrides). Kill stray daemons first; if a
   competing worktree daemon keeps respawning, mark SDK-gated tests blocked. If the
   MCP tools are build-skewed after the restart, drive tools via the CLI
   (`bun dist/src/index.js --cli <tool> --<param> <value>`).
4. **Exercise tool calls** — Android first, then iOS, one device at a time. For each
   item, ground the result in an observed field or adb/simctl ground truth, not the
   tool's `success` flag. Sweep the changed surface for regressions.
5. **Report & file** — per-item FIXED/PASS/NOT-FIXED/REGRESSED/BLOCKED table with
   evidence; file issues for regressions/unfixed (repro + root cause + suggested
   fix); comment verification results on the closed issues / merged PRs.

If the user passed extra flags or a device/scope hint after the start point (e.g.
"with --embedded-sdk", "android only", "just the observe changes"), honor them when
choosing rebuild targets, daemon flags, and which items to exercise.

Keep output tight — summarize tool results, never paste raw hierarchies.
