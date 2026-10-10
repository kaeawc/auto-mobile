---
name: android-gradlew
description: Helper skill for Android-specific validation or build work in the android/ subdirectory; use it when another task needs Gradle wrapper commands run from android/.
---

# Android Gradle Wrapper

Run Android work from `android/` via the Gradle wrapper. Never run Gradle tasks from the repo root.

## Prerequisites

- A new worktree needs `android/local.properties` copied from a working checkout. It is gitignored and Gradle cannot resolve the SDK without it. Never commit it.
- Never read or print `~/.gradle/gradle.properties`; it holds publishing credentials.

## Running tasks

- Default: `bash scripts/android/gradlew_task.sh <task> [flags]`. It works from any cwd, runs `./gradlew` from `android/` with the arguments unchanged, and returns Gradle's exit code. Combined stdout and stderr are shown and saved to `scratch/gradlew-<UTC timestamp>-<pid>.log`; the log path is printed to stderr before and after the run. `-h` or `--help` as the first argument prints usage.
- Equivalent without the script: `(cd android && ./gradlew <task>)`.
- Use module-scoped tasks that match the request, for example `:junit-runner:test`, `:playground:app:test` or `:auto-mobile-sdk:apiDump`.
- To reproduce CI's Detekt job run the type-resolved `detektMain detektTest`; a per-module `:module:detekt` run does not reproduce it.
- Write long output to `scratch/` (the script already does) and read excerpts instead of pasting full logs.

## Related skills

- `prepush-android` for the fast pre-push smoke check (`scripts/prepush-android.sh`).
- `validate` and `test` for broader lint, build and test runs.
- `check-ci` for exact-head CI logs and artifacts.

Treat this as a building-block skill for those, not as the primary workflow when the user asks for a broader task.
