---
name: pr-analysis
description: Use this workflow skill for a deep, read-only PR review covering intent, code quality, regression risk, test gaps, and feedback status; prefer it over check-ci when the request is broader than CI triage.
---

# PR Analysis

Perform a read-only PR review that covers intent, correctness, regression risk, tests, and existing feedback.

## Workflow

1. Resolve the PR with `gh pr view <pr> --json ...` and capture the head branch, base branch, title, and body.
2. Gather context with `gh pr diff`, `gh pr diff --stat`, `gh pr checks`, all
   paginated review/inline/conversation comments, and review verdicts.
3. Always collect GraphQL review-thread state for PR analysis: unresolved and
   outdated threads are not represented reliably by flat comment views. Reuse
   `github-pr-feedback` for the collection and ledger.
4. Read full changed files from the PR branch and the base branch, not just diff hunks.
5. Find related callers, interfaces, and tests in the local codebase.
6. If validation is warranted, run the lightest relevant repo validation rather than a blanket heavy build.
7. Produce findings first, then open questions, then a short summary.

## Repo Rules

- Prefer `gh` for PR metadata and CI data.
- Prefer repo validations:
  - TypeScript: `bun run lint`, `bun run build`, `bun test`
  - Fast checks: `bash scripts/all_fast_validate_checks.sh`
  - Android or iOS only when the PR actually touches those areas
- Keep the analysis read-only unless the user explicitly asks for fixes.
- When saving large diffs or logs, put them in `scratch/`.

## Output Structure

- Findings ordered by severity with `file:line` references
- Open questions or assumptions
- Brief change summary and residual risks
