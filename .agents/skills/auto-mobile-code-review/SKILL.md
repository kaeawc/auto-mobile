---
name: auto-mobile-code-review
description: Use this workflow skill to review an AutoMobile change (a PR number or the current branch diff) the way this repo demands — check the PR's real CI, merge and base state first, then run diff-sized review lenses (two fixed, one generated) covering runtime behavior and delivery/enforcement, grounding every finding in file:line and reproducing before asserting. Never posts to GitHub; resolves review threads only on a PR we authored and are actively working.
---

# AutoMobile Code Review

Read and follow the canonical AutoMobile code review skill at
`../../../skills/auto-mobile-code-review/SKILL.md`.

Treat that file as the source of truth for the workflow. This wrapper only
exposes the shared repo skill through Codex's `.agents/skills` discovery path.
