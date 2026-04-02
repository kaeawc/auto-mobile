---
name: dead-code
description: Use this skill to detect and clean up dead code in this repo, starting with the project’s TypeScript dead-code scripts and validating that removals do not regress behavior.
---

# Dead Code

Use this when the user wants dead-code analysis or cleanup.

## Workflow

1. Start with detection, not deletion.
2. For TypeScript, run `bash scripts/detect-dead-code-ts.sh`, optionally writing reports to `scratch/dead-code/`.
3. Review each candidate in full context before removing it. Unused exports in tooling output are often false positives.
4. Check callers, tests, generated code, and dynamic entry points before deleting anything.
5. Remove dead code in small batches so regressions are easy to isolate.
6. Re-run the detector and the relevant validation after each batch.

## Repo Rules

- Prefer repo scripts and `bun` tasks over ad hoc dead-code tools.
- Treat `package.json` dependency findings as suggestions until confirmed.
- Do not remove code referenced by reflection, CLI wiring, generated schemas, MCP registration, or platform build files without proof.
- Validate behavior after cleanup with the narrowest relevant commands.

## Typical Validation

- `bun run lint`
- `bun run build`
- `bun test`
- `bash scripts/validate-bun-test-timings.sh` when test changes may affect the 100ms expectation
