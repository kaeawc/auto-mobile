# Android dependency injection: Metro only

- Kind: decision
- Date: 2026-10-15
- Source: moved from `how-it-works/plat/android/dependency-injection.md`; #11883, #11876, #12408
- Shaped: [Android dependency injection position](../how-it-works/plat/android/dependency-injection.md)

## Context

#11883 asked for one DI position across `android/`. The position was verified against `main` at
`1c7e808b54` (2026-10-15).

## Options

Metro, Koin, Dagger, Hilt, or manual constructor injection.

## Decision

The owner's stated preference is Metro, not Koin. Metro is the only DI framework allowed, opt-in per
module that owns a root graph; every other module uses manual constructor injection.

## Consequences

- If `control-proxy`'s `lateinit` plus `isInitialized` pattern is reduced (the CtrlProxy split
  tracked in #11876), the replacement is a hand-written graph built in `onCreate`, not a framework,
  unless the owner decides to align it with desktop on Metro. That is a separate decision.

### Evidence at decision time

Counts came from a `grep`/`find` over each module's `src/` on `main`.

| Module                                                             | DI in use                                | Evidence                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------ | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `desktop-app`                                                      | Metro (graph root)                       | Metro plugin applied in `desktop-app/build.gradle.kts`; `@DependencyGraph(scope = AppScope::class)` on `desktop/di/AutoMobileGraph.kt`; `createGraphFactory` in `desktop/Main.kt`; `metro.runtime` dependency.                                                                                        |
| `desktop-core`                                                     | Metro (contributions)                    | Metro plugin applied in `desktop-core/build.gradle.kts`; `@ContributesTo` / `@Provides` in `core/di/ApplicationModule.kt`; `@ContributesBinding` plus `@Inject` in `core/datasource/DataSourceFactory.kt`; scope marker in `core/di/AppScope.kt`.                                                     |
| `desktop-domain`                                                   | None (plain Kotlin)                      | No Metro, Koin, Dagger, or Hilt import in its 16 source files. Its only "inject" hits are prose about input events.                                                                                                                                                                                   |
| `control-proxy`                                                    | Manual composition                       | No Metro plugin in `control-proxy/build.gradle.kts`. 383 Kotlin files. `CtrlProxy.kt` wires collaborators by hand with 7 `lateinit var` fields and 100 `isInitialized` checks; 17 `by lazy` properties in the module. Android constructs the service, so it has no graph root to hang a framework on. |
| `auto-mobile-sdk`                                                  | Manual composition plus `object` facades | No DI framework. 30 Kotlin `object` declarations, including the public `AutoMobileSDK` facade. Kept on purpose (see point 5).                                                                                                                                                                         |
| `ide-plugin`                                                       | Platform services                        | No DI framework. Two files touch `ServiceManager` / `ApplicationManager` / `getService(`.                                                                                                                                                                                                             |
| `video-server`, `junit-runner`, `protocol`, `test-plan-validation` | Manual composition                       | No DI framework, annotation, or plugin in any file.                                                                                                                                                                                                                                                   |
| `playground/*`                                                     | Manual composition                       | Zero Koin, Hilt, Dagger, or Metro hits across all playground Kotlin and Gradle files.                                                                                                                                                                                                                 |
