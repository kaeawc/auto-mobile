# Autocomplete Namespace & Internal Leakage Audit

## Summary

Audit of public API surfaces on Android (Kotlin) and iOS (Swift) to identify internal
implementation types that leaked into IDE autocomplete for SDK consumers.

## Android Changes

### Made `internal`

The following types were implementation details exposed as public. Marking them
`internal` hides them from Kotlin consumers' IDE autocomplete while leaving the
JVM bytecode unchanged (Kotlin `internal` compiles to JVM `public`).

| Type                                                | Reason                                                                            |
| --------------------------------------------------- | --------------------------------------------------------------------------------- |
| `RecompositionTracker`                              | Internal recomposition tracking, used only by Compose APIs and `AutoMobileSDK`    |
| `DefaultDropCounter`                                | Implementation of `DropCounter` interface                                         |
| `SdkContext`                                        | Internal mutable context; only `SdkContextSnapshot` is consumer-facing            |
| `SessionTracker` / `SessionTracking`                | Internal session lifecycle management                                             |
| `AutoMobileClickTracker`                            | Internal click tracking subsystem                                                 |
| `AutoMobileBroadcastInterceptor`                    | Internal broadcast interception subsystem                                         |
| `AutoMobileOsEvents`                                | Internal OS event monitoring subsystem                                            |
| `FileEventPersistence`                              | Implementation of `EventPersistence`                                              |
| `EventPersistence`                                  | Internal persistence interface                                                    |
| `DropCounter` (interface)                           | Internal drop-counting interface; `DropReason` stays public for `getDropReport()` |
| `NoOpDropCounter`                                   | Internal no-op implementation                                                     |
| `NoOpEventPersistence`                              | Internal no-op implementation                                                     |
| `NoOpEventProcessor`                                | Internal no-op implementation                                                     |
| `NoOpNavigationListener`                            | Internal no-op implementation                                                     |
| `FileSystemOperations` / `RealFileSystemOperations` | Internal file system abstraction                                                  |
| `SharedPreferencesDriverImpl`                       | Internal `SharedPreferencesDriver` implementation                                 |

### Added `@RestrictTo`

These types stay JVM-public (they are used cross-process / cross-module), so
they are annotated `@RestrictTo` rather than made `internal`. The annotation
warns consumers in the IDE while leaving the symbol callable at runtime.

| Type                          | Scope           | Reason                                                                                                                                              |
| ----------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ConfigurationOverrideHelper` | `LIBRARY`       | Test-only utility in main source set                                                                                                                |
| `SdkEventBroadcaster`         | `LIBRARY_GROUP` | Public `object` used for cross-process broadcast delivery; needs to stay JVM-public, so restricted to the library group rather than made `internal` |

### Remaining Issues (Cannot Fix)

| Issue                                 | Explanation                                                                               |
| ------------------------------------- | ----------------------------------------------------------------------------------------- |
| `$stable` fields on every class       | Compose compiler artifact; synthetic field, not removable                                 |
| `WhenMappings` inner classes          | Kotlin compiler artifact for `when` expressions on enums                                  |
| `CompiledLogFilter`                   | Was in previous API dump but source file already deleted; resolved by new apiDump         |
| JVM-level public for `internal` types | Kotlin `internal` compiles to JVM `public`; only Kotlin consumers respect the restriction |

## iOS Changes

### Made `internal` (removed `public`)

| Type                                          | Reason                                                                        |
| --------------------------------------------- | ----------------------------------------------------------------------------- |
| `DateProvider` / `SystemDateProvider`         | DI/testing abstraction, not consumer-facing                                   |
| `DropCounting` / `DefaultDropCounter`         | Internal drop-counting infrastructure                                         |
| `EventBuffering` / `SdkEventBuffer`           | Internal event buffer infrastructure                                          |
| `TimerScheduling` / `GCDTimer`                | Internal timer abstraction                                                    |
| `EventBroadcasting` / `SdkEventBroadcaster`   | Internal broadcast delivery                                                   |
| `EventPersisting` / `FileEventPersistence`    | Internal disk persistence                                                     |
| `SdkContext`                                  | Internal mutable context; `SdkContextSnapshot` stays public                   |
| `SessionTracking` / `SessionTracker`          | Internal session management                                                   |
| `AutoMobileSDK.sdkContext` (property)         | Exposed internal type; changed to `internal`                                  |
| `AutoMobileSDK.dropCounter` (property)        | Exposed `DropCounting`; changed to `internal`                                 |
| `AutoMobileSDK.getEventBuffer()`              | Returned internal type; changed to `internal`                                 |
| `ViewBodyTracker.setEnabled(_:timerFactory:)` | Overload with `TimerScheduling` param made internal; public overload retained |

### Kept Public (Consumer-Facing)

`DropReason` remains public because it appears in `AutoMobileSDK.dropReport: [DropReason: Int]`.
`EventProcessing` remains public because it appears in `AutoMobileConfiguration.eventProcessors`.

## Public API Symbol Count

### Android (classes/interfaces in API dump)

These are as-of-audit snapshot figures — the committed
`android/auto-mobile-sdk/api/auto-mobile-sdk.api` continues to drift as classes
are added by later PRs (it currently holds ~135), so treat the delta, not the
absolute, as the point:

- Before: 129 classes
- After (at audit time): 134 classes (net +5 due to `BackPressureStrategy` and
  `SdkEventBuffer$WhenMappings` now appearing in release build; `CompiledLogFilter`
  removed as stale)

Note: The Android API dump uses javap which reflects JVM bytecode. Kotlin `internal` types still
appear as JVM `public` but are hidden from Kotlin consumers at the language level.

### iOS (public declarations)

- Before: ~90 public declarations
- After: ~60 public declarations (30 declarations moved to internal)
