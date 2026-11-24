# Docs readability in the pre-push shell lane

- Kind: decision
- Date: 2026-11-23
- Source: #19103, #19104, #19105, #19106, #19107
- Shaped: [Pre-push vs CI misses](../how-it-works/ci/prepush-ci-misses.md)

## Context

The `Docs Readability Report` job ran only in CI on docs-path pull requests. Four pull requests
on 2026-11-23 (#19103 to #19106) added docs pages with enforced findings and needed a second push.
Three pages on `main` were also over budget (#19107), so a whole-tree local run would fail every
docs change.

## Options

- Run the whole-tree check in the shell lane.
- Run the check only on the docs pages the branch changed.
- Leave readability to CI.

## Decision

A `docs-readability` Fast Validation check runs `check-readability.ts --files` on the docs pages
changed since the merge-base with the base ref, plus uncommitted and untracked edits. The shell
lane selects it for `docs/**/*.md` and readability checker changes, and passes its base ref.

## Consequences

A new finding in a changed page fails pre-push with the same file, line and rule CI reports.
Findings in untouched pages still fail only the CI job. CI Fast Validation does not run this
check, because the CI job already checks the whole tree.
