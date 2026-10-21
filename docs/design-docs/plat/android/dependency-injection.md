# Android dependency injection position

Status: current position, verified against `main` at `1c7e808b54` (2026-10-15). Tracks #11883.

## Position

1. **Metro is the only DI framework allowed in `android/`.** The owner's stated
   preference is Metro, not Koin. Koin, Dagger, and Hilt are not used anywhere
   in the Android tree and must not be introduced.
2. **Metro is opt-in per module.** A module adopts it only when it has a graph
   to own (a root `@DependencyGraph`) and the plugin is applied in that module's
   own build file. The root `android/build.gradle.kts` declares the plugin with
   `apply false`; it does not apply it globally.
3. **Everywhere else, use manual constructor injection.** Collaborators are
   passed in through constructors, with interfaces and fakes for tests. Do not
   add a framework for a module that has no graph to own.
4. **Platform-owned lookup stays platform-owned.** IntelliJ services in
   `ide-plugin` are resolved through the platform service API, not a DI
   framework.
5. **Zero-setup SDK facades stay `object`s.** `auto-mobile-sdk` exposes its API
   as Kotlin `object` singletons so consumers need no setup. That is a deliberate
   public-API shape, not a missing DI graph.

## Per-module rule and evidence

Counts are from a `grep`/`find` over each module's `src/` on `main`. Re-run the
same greps before relying on a number.

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

Version pin: `metro = "1.4.5"` in `android/gradle/libs.versions.toml`. No
`ksp` or `kapt` processors are declared for DI in any module.

## What this means in practice

- A new Android-target module (control-proxy, SDK, playground, etc.) starts
  with constructor injection. It does not add Metro unless it introduces its
  own root graph, and then it adds the plugin in its own build file.
- A new desktop feature that needs a shared singleton goes through
  `@ContributesTo(AppScope::class)` in `desktop-core`, not a hand-built global.
- If `control-proxy`'s `lateinit` plus `isInitialized` pattern is reduced
  (the CtrlProxy split tracked in #11876), the replacement is a hand-written graph
  built in `onCreate`, not a framework, unless the owner decides to align it with
  desktop on Metro. That choice is a separate decision and is not made here.
