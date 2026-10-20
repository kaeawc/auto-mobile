---
name: node-prepush
description: Run the Node pull-request gates before pushing TypeScript changes, and triage verified flakes without speculative test changes.
---

# Node Pre-push

Use this workflow before pushing a Node or TypeScript change.

1. Run `bash scripts/prepush-node.sh`. During a short local feedback loop, use
   `bash scripts/prepush-node.sh --changed`; it still runs format, typecheck,
   and lint in full because their baseline and boundary gates are global.
2. Treat a non-zero `bun run lint` exit as a failure. Error-level oxlint rules
   such as `eqeqeq` are direct gates; the warning ratchet cannot excuse them.
3. The first gate fetches `origin/main` and requires the current HEAD to
   contain it. Rebase or merge main, then re-run the gate before requesting a
   merge.
4. For a suspected Node CI flake, inspect the exact failed job log and rerun
   only after evidence supports it. This week's verified loaded-runner 100ms
   timing overages use the timing gate's isolated recheck; do not alter tests
   when that recheck is clean. Treat a matching cross-platform failure as
   shared state or stale base until proven otherwise.

## What the gate reproduces, and what stays CI-only

`prepush-node.sh` runs: stale-base guard, `format:check`, `typecheck`, `lint`
(oxlint, ratchet, `check-boundaries.sh`), `typecheck:test`, tool
definitions drift, the static Fast Validation subset (`yaml`, `runtime-pins`,
`stdlib-first`, `shared-process-allowlist`, `docs-assets`, `env-var-docs`,
`lfs-pointers`, `lychee-offline`, and the other tool-free checks named in
`FAST_VALIDATION_CHECKS`), repository lint tests, the image smoke, the unit lane, the
`test/db` fast path, and the 100 ms timing budget on Linux.

Repository lint tests run only `test/lint/*.integration.test.ts` in full mode;
the unit files already run in the unit lane. In `--changed` mode, early affected-test
selection supplies branch, worktree, and untracked paths; the whole `test/lint/`
directory runs only for changes under `src/`, `test/`, `scripts/`, `oxlint-plugins/`,
`android/`, `ios/`, `docs/`, `skills/`, `schemas/`, `.claude/`, `.github/`, or root
`.oxlintrc.json`, `package.json`, `bun.lock`, `bunfig.toml`, `turbo.json`, or
`tsconfig*.json`. After that directory runs, affected unit and integration extras
omit `test/lint/` files already covered. Always-run unit extras still run when
repository lint tests skip.
A unit cap fallback replaces the changed lane with the full unit lane and skips
unit extras; always-run bats and affected safe integration lanes still run afterward.
The timing gate measures the unit lane's JUnit reports when source or runtime
inputs changed; changed test files alone are still re-run individually. Changed
mode without reports uses the timing validator's own affected-test selection.
Typecheck and lint stay strictly serial and separate because oxlint 1.88's experimental
`--type-check` and tsgolint diagnostics do not replace the fail-closed typecheck parser,
TS2688/`@types/bun` guard, or separate src/test tsconfig projects.

CI-only by design: the Windows and macOS unit/integration legs (path
separators, `test/lint/pathSeparatorAssertions.test.ts` is the static proxy),
the loaded-runner timing budget (a local pass proves only the unloaded case;
`--timing` forces it on macOS), ShellCheck at CI's pinned version (local may be
newer: keep `# shellcheck disable=SC2329` paired with SC2317), online docs link
checks (`merge.yml`), the clean-room pinned runtime graph install
(`scripts/ci/verify-pinned-runtime-graph.sh`, needs network), benchmarks,
CodeQL, and the Android/iOS/desktop builds.
