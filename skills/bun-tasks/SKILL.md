---
name: bun-tasks
description: Helper skill for repo-root Bun commands; use it when another skill needs a package.json script instead of an ad hoc command.
---

# Bun Tasks

Use `package.json` scripts through Bun instead of ad hoc root commands.

- Check `package.json` first for an existing script.
- Run repo tasks with `bun run <script>`.
- Prefer existing scripts such as `lint`, `build`, `test`, `benchmark-context`, and `validate:yaml`.
- When a Bun command emits output you need to inspect later, write it to `scratch/` and summarize the result.
- Treat this as a helper for `validate`, `test`, `check-ci`, or `dead-code`, not as the main workflow when the user asks for a higher-level task.
