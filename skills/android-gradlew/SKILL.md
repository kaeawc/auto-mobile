---
name: android-gradlew
description: Helper skill for Android-specific validation or build work in the android/ subdirectory; use it when another task needs Gradle wrapper commands run from android/.
---

# Android Gradle Wrapper

Run Android work from `android/` via the Gradle wrapper.

- Prefer `(cd android && ./gradlew <task>)` or `bash scripts/android/gradlew_task.sh <task>` once that wrapper script is implemented.
- Do not run Gradle tasks from the repo root.
- Choose explicit tasks that match the request, such as `test`, `lint`, `assemble`, or a module-scoped task.
- Save long Gradle output under `scratch/` when you need to inspect logs that will not be shown directly.
- Treat this as a building-block skill for `validate`, `test`, or `check-ci`, not as the primary workflow when the user asks for a broader task.
- Pair this with `local-validation-scripts` when a repo script already wraps the Android validation you need.
