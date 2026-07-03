---
name: auto-mobile-code-review
description: "Use this workflow skill to review an AutoMobile change (a PR number or the current branch diff) the way this repo demands: ground every finding in file:line, reproduce before asserting, separate real bugs from daemon-session/environment artifacts, prefer reusing existing repo helpers and conventions over new code, and catch the regression or false-negative a fix can introduce."
---

# AutoMobile Code Review

Read and follow the canonical AutoMobile code review skill at
`../../../skills/auto-mobile-code-review/SKILL.md`.

Treat that file as the source of truth for the workflow. This wrapper only
exposes the shared repo skill through Codex's `.agents/skills` discovery path.
