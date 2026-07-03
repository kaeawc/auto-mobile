---
name: test
description: "Use this workflow skill for running tests only: choose the narrowest relevant test command first and keep test runs fast and actionable; prefer validate when the user wants broader non-test checks too."
---

# Run Tests

Use the smallest test command that answers the user’s question.

- This skill is test-focused.
- Prefer `validate` when lint, build, formatting, or other non-test checks are part of the request.

## Workflow

1. Determine the scope from the changed files or the user request.
2. Prefer targeted tests before full suites.
3. For TypeScript, use `bun test <file>` or `bun test --bail` before `bun test` when narrowing failures.
4. For Android or iOS, run only the relevant platform test command.
5. Save verbose logs to `scratch/` when needed and summarize failures with file names and root causes.

## Repo Validation Mapping

- TypeScript all tests: `bun test`
- Single TypeScript file: `bun test <file>`
- Timing budget check: `bash scripts/validate-bun-test-timings.sh`
- Android: `(cd android && ./gradlew test)` or a narrower task
- iOS Swift package tests: `bash scripts/ios/swift-test.sh`
- Local component or integration flows: prefer a purpose-built script in `scripts/`

## Test Quality Rules

- Keep unit tests fast and deterministic.
- Use interfaces, fakes, and fake timers when adding or fixing tests.
- Do not accept a failing test as an allowable outcome.
