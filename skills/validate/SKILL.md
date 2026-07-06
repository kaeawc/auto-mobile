---
name: validate
description: Use this workflow skill for broader project validation across lint, build, formatting, config, and platform checks; prefer test when the request is only about executing tests.
---

# Validate Changes

Run the lightest validation that covers the touched code, then widen only when needed.

- Prefer `validate` for multi-check verification.
- Prefer `test` when the request is specifically about running tests or reproducing a test failure.
- Before inventing a validation command, check `scripts/` and `scripts/README.md` for an existing validator.

## Baseline Validation

- `bun run lint`
- `bun run build`
- `bun run turbo:validate` for the local Turbo lint/build/test gate

## Repo Script Validation

- Codex skills and `AGENTS.md`: `bash scripts/validate_codex_skills.sh`
- Fast multi-check pass: `bash scripts/all_fast_validate_checks.sh`
- Dockerfile: `bash scripts/hadolint/validate_hadolint.sh`
- GitHub Actions local runner setup: `bash scripts/act/validate_act.sh`
- Swift build: `bash scripts/ios/swift-build.sh`
- Swift format: `ONLY_TOUCHED_FILES=false bash scripts/swiftformat/validate_swiftformat.sh`
- Swift lint: `ONLY_TOUCHED_FILES=false bash scripts/swiftlint/validate_swiftlint.sh`
- Other useful validators:
  - `bash scripts/validate-bun-test-timings.sh`
  - `bash scripts/detect-dead-code-ts.sh`

## Selection Rules

- TypeScript-only changes usually need `lint`, `build`, and relevant tests.
- Use `bun run turbo:*` scripts instead of bare `turbo ...`; Turbo is installed locally and may not be on the shell `PATH`.
- Shell or docs/config changes should prefer the matching script in `scripts/`.
- Android changes should use the Gradle wrapper from `android/`.
- iOS changes should use the existing `scripts/ios/` entry points.
- Write long validation output to `scratch/` and report only the actionable failures.
