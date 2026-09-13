---
name: prepush-android
description: Run the fast Android pre-push smoke check for changed Kotlin modules, then interpret emulator CI failures from boot diagnostics before treating them as regressions.
---

# Android Pre-push

Read and follow the canonical Android pre-push skill at
`../../../skills/prepush-android/SKILL.md`.

Treat that file as the source of truth for the workflow. This wrapper only
exposes the shared repo skill through Codex's `.agents/skills` discovery path.
