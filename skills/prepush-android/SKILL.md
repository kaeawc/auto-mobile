---
name: prepush-android
description: Run the fast Android pre-push smoke check for changed Kotlin modules, then interpret emulator CI failures from boot diagnostics before treating them as regressions.
---

# Android Pre-push Smoke Check

- Run `scripts/prepush-android.sh` from the repository root before pushing `android/` changes.
- Treat its scoped Detekt result as a local smoke check, not a replacement for CI's full-tree Detekt job.
- Copy `android/local.properties` from a working checkout into a new Android worktree before Gradle work.
- For Playground or JUnit-runner emulator CI red, inspect `.github/actions/android-emulator` boot diagnostics first: missing runner-health means infra/runner readiness, while a booted emulator with failed tests is a regression.
- Use `android-gradlew` for targeted Gradle validation and `check-ci` for exact-head CI logs and artifacts.
