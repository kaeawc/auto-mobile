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
