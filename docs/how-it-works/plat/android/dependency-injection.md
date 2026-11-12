# Android dependency injection position

## Position

1. **Metro is the only DI framework allowed in `android/`.** Koin, Dagger and Hilt are not used in
   the Android tree and must not be introduced.
2. **Metro is opt-in per module.** A module adopts it only when it owns a root `@DependencyGraph`, and
   applies the plugin in its own build file. The root `android/build.gradle.kts` declares the plugin
   with `apply false`.
3. **Everywhere else, use manual constructor injection**, with interfaces and fakes for tests. Do not
   add a framework to a module with no graph to own.
4. **Platform-owned lookup stays platform-owned.** IntelliJ services in `ide-plugin` resolve through
   the platform service API.
5. **Zero-setup SDK facades stay `object`s.** `auto-mobile-sdk` exposes its API as Kotlin `object`
   singletons so consumers need no setup. That is a deliberate public-API shape, not a missing graph.

## Per module

| Module                                                             | DI in use                                | Where                                                                                                                                           |
| ------------------------------------------------------------------ | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `desktop-app`                                                      | Metro (graph root)                       | `@DependencyGraph(scope = AppScope::class)` on `desktop/di/AutoMobileGraph.kt`; `createGraphFactory` in `desktop/Main.kt`; `metro.runtime`      |
| `desktop-core`                                                     | Metro (contributions)                    | `@ContributesTo` / `@Provides` in `core/di/ApplicationModule.kt`; `@ContributesBinding` + `@Inject` in `core/datasource/DataSourceFactory.kt`   |
| `desktop-domain`                                                   | None (plain Kotlin)                      |                                                                                                                                                 |
| `control-proxy`                                                    | Manual composition                       | `CtrlProxy.kt` wires collaborators by hand (`lateinit var` fields and `isInitialized` checks); Android constructs the service, so no graph root |
| `auto-mobile-sdk`                                                  | Manual composition plus `object` facades | Public `AutoMobileSDK` facade (point 5)                                                                                                         |
| `ide-plugin`                                                       | Platform services                        | `ServiceManager` / `ApplicationManager` / `getService(`                                                                                         |
| `video-server`, `junit-runner`, `protocol`, `test-plan-validation` | Manual composition                       |                                                                                                                                                 |
| `playground/*`                                                     | Manual composition                       |                                                                                                                                                 |

Version pin: `metro = "1.5.2"` in `android/gradle/libs.versions.toml`. No module declares `ksp` or
`kapt` processors for DI.

## In practice

- A new Android-target module (control-proxy, SDK, playground, etc.) starts with constructor
  injection. It adds Metro only with its own root graph, and then in its own build file.
- A new desktop feature that needs a shared singleton goes through `@ContributesTo(AppScope::class)`
  in `desktop-core`, not a hand-built global.
- A reduction of `control-proxy`'s `lateinit` plus `isInitialized` pattern uses a hand-written graph
  built in `onCreate`, not a framework, unless a separate decision aligns it with desktop on Metro.

## Background

- [Android dependency injection: Metro only](../../../devlog/2026-10-15-dependency-injection-metro-only.md)
