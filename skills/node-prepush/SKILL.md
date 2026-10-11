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
(oxlint, ratchet, `check-boundaries.sh`), the test as-any ratchet, tool
definitions drift, the static Fast Validation subset (`yaml`, `runtime-pins`,
`stdlib-first`, `shared-process-allowlist`, `docs-assets`, `env-var-docs`,
`lfs-pointers`, `lychee-offline`, and the other tool-free checks named in
`FAST_VALIDATION_CHECKS`), `test/lint/`, the image smoke, the unit lane, the
`test/db` fast path, and the 100 ms timing budget on Linux.

CI-only by design: the Windows and macOS unit/integration legs (path
separators, `test/lint/pathSeparatorAssertions.test.ts` is the static proxy),
the loaded-runner timing budget (a local pass proves only the unloaded case;
`--timing` forces it on macOS), ShellCheck at CI's pinned version (local may be
newer: keep `# shellcheck disable=SC2329` paired with SC2317), online docs link
checks (`merge.yml`), the clean-room pinned runtime graph install
(`scripts/ci/verify-pinned-runtime-graph.sh`, needs network), benchmarks,
CodeQL, and the Android/iOS/desktop builds.
