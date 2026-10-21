# AutoMobile Android

Quick reference for AI agents working in `android/`. Run all commands from the repo root unless noted.

## Project Layout
- `android/` - Android Kotlin Gradle project (apps, libraries, JUnit runner)
- `android/ide-plugin/` - IntelliJ/Android Studio plugin (Gradle project)

## Common Commands (from repo root)
- `./gradlew -p android <task>`
- `./gradlew -p android :junit-runner:test`
- `./gradlew -p android :control-proxy:assembleDebug`
- `./gradlew -p android :ide-plugin:build`

## Notes
- Prefer `./gradlew -p android` to avoid changing directories.
- Android validation scripts live under `scripts/ktfmt/`, `scripts/xml/`, and `scripts/android/`.
- Kotlin is formatted with **ktfmt `--google-style`** (2-space block + 2-space continuation indent), pinned in `scripts/ktfmt/install_ktfmt.sh`. Auto-format touched files with `scripts/ktfmt/apply_ktfmt.sh`; CI enforces it tree-wide via `scripts/ktfmt/validate_ktfmt.sh`.

## Dependency Injection
- **Metro is the only DI framework allowed in `android/`; Koin, Dagger and Hilt are not used and must not be introduced.** Metro is opt-in per module and applied in that module's own build file (the root declares the plugin with `apply false`). Today only `desktop-app` (graph root) and `desktop-core` (contributions) use it.
- Every other module (`control-proxy`, `auto-mobile-sdk`, `video-server`, `junit-runner`, `protocol`, `playground/*`, ...) uses manual constructor injection with interfaces and fakes; `ide-plugin` resolves IntelliJ platform services through the platform API. The SDK's Kotlin `object` facades are a deliberate zero-setup public API, not a missing graph.
- A new module starts with constructor injection and adds Metro only when it owns a root `@DependencyGraph`. Per-module evidence and the `control-proxy` `lateinit` note are in `docs/design-docs/plat/android/dependency-injection.md`.
