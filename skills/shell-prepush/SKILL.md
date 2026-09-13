---
name: shell-prepush
description: "Use this workflow skill before pushing shell or scripts changes to run scoped fast validation and targeted BATS tests, interpret stale dependency-pin failures, and retrieve empty Fast Validation logs from artifacts."
---

# Shell Prepush

Use this before pushing changes under `scripts/`, shell hooks, agent skills, or
related documentation. It is a local pre-push check, not a replacement for the
required CI jobs.

## Workflow

1. Run `scripts/prepush-shell.sh`; it compares the branch to `origin/main`, or
   `main` when the remote-tracking ref is unavailable, and selects only the
   applicable fast checks plus targeted BATS files.
2. Run `bun run format` before pushing. A failed Check Formatting job also
   makes Fast Validation fail at its formatter gate.
3. If `runtime-pins`, `sharp-matrix`, or `pin-runtime-deps.bats` fails and
   `bun.lock` and/or `package.json` changed in the diff, run
   `bun scripts/release/pin-runtime-deps.ts --write` and commit `package.json`,
   `bun.lock`, and `scripts/release/runtime-graph.json`; otherwise rebase onto
   current main and do not hand-edit pins to mask a stale base.
4. Never run two `bats test/bats/` sweeps concurrently on one machine. The
   targeted BATS invocation from `prepush-shell.sh` is safe to run on its own.
5. When an Actions API job log is empty, download the `fast-validation-logs`
   artifact and inspect its per-check `.status` and `.log` files under
   `scratch/fast-validate-*/`.

## Repo Validation Mapping

- Shell/scripts pre-push: `scripts/prepush-shell.sh`
- Scoped fast checks: `./scripts/all_fast_validate_checks.sh --only <names>`
- Targeted shell tests: `bats test/bats/<matching-file>.bats`
- Formatting: `bun run format`
