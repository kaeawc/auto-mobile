# Cross-Platform API Parity Report

Side-by-side comparison of every public API symbol on Android and iOS.

---

## 1. Core SDK Entry Point

| API                        | Android (`AutoMobileSDK`)                        | iOS (`AutoMobileSDK`)                          | Notes                                                                                 |
| -------------------------- | ------------------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------- |
| Singleton                  | `INSTANCE` (object)                              | `shared` (static let)                          | Platform idiom                                                                        |
| `initialize`               | `initialize(Context)`                            | `initialize(bundleId:)`                        | Android uses Context; iOS uses optional bundleId                                      |
| `initialize` (config)      | `initialize(Context, Configuration)`             | `initialize(bundleId:configuration:)`          | Aligned                                                                               |
| `setEnabled`               | `setEnabled(Boolean)`                            | `setEnabled(Bool)`                             | Aligned                                                                               |
| `isEnabled`                | `isTrackingEnabled` (val)                        | `isEnabled` (property)                         | Naming differs: Android `isTrackingEnabled`, iOS `isEnabled`                          |
| `addNavigationListener`    | `addNavigationListener(NavigationListener)`      | `addNavigationListener(NavigationListener)`    | Aligned                                                                               |
| `removeNavigationListener` | `removeNavigationListener(NavigationListener)`   | `removeNavigationListener(NavigationListener)` | Aligned                                                                               |
| `clearNavigationListeners` | `clearNavigationListeners()`                     | `clearNavigationListeners()`                   | Aligned                                                                               |
| `notifyNavigationEvent`    | `notifyNavigationEvent(NavigationEvent)`         | `notifyNavigationEvent(NavigationEvent)`       | Aligned                                                                               |
| `listenerCount`            | `listenerCount` (val)                            | `listenerCount` (property)                     | Aligned (Kotlin val; JVM getter `getListenerCount()`)                                 |
| `currentSessionId`         | `currentSessionId()`                             | `currentSessionId()`                           | Aligned                                                                               |
| `addBreadcrumb`            | `addBreadcrumb(String, BreadcrumbCategory, Map)` | `addBreadcrumb(message:category:metadata:)`    | Aligned                                                                               |
| `shutdown`                 | `shutdown()`                                     | `shutdown()`                                   | Aligned                                                                               |
| `setUserId`                | `setUserId(String?)`                             | `setUserId(String?)`                           | Aligned                                                                               |
| `setTag`                   | `setTag(String, String)`                         | `setTag(String, value: String)`                | Aligned                                                                               |
| `removeTag`                | `removeTag(String)`                              | `removeTag(String)`                            | Aligned                                                                               |
| `dropReport`               | `dropReport` (val)                               | `dropReport` (property)                        | Aligned (Kotlin val; JVM getter `getDropReport()`)                                    |
| `contextSnapshot`          | `contextSnapshot` (val)                          | `sdkContext?.snapshot()`                       | Android `val contextSnapshot` (JVM getter `getContextSnapshot()`); iOS via SdkContext |
| `configuration`            | `getConfiguration()` (internal)                  | `configuration` (property)                     | Both available                                                                        |

## 2. Configuration

| API                | Android (`AutoMobileConfiguration`)     | iOS (`AutoMobileConfiguration`)      | Notes                                                          |
| ------------------ | --------------------------------------- | ------------------------------------ | -------------------------------------------------------------- |
| `bufferSize`       | `bufferSize: Int`                       | `bufferSize: Int`                    | Aligned                                                        |
| `flushIntervalMs`  | `flushIntervalMs: Long`                 | `flushIntervalMs: Int`               | Aligned (type difference is platform idiom)                    |
| `maxBreadcrumbs`   | `maxBreadcrumbs: Int`                   | `maxBreadcrumbs: Int`                | Aligned                                                        |
| `sessionTimeoutMs` | `sessionTimeoutMs: Long`                | `sessionTimeoutMs: Int`              | Aligned                                                        |
| `eventProcessors`  | `eventProcessors: List<EventProcessor>` | `eventProcessors: [EventProcessing]` | Aligned                                                        |
| `maxPendingEvents` | `maxPendingEvents: Int`                 | `maxPendingEvents: Int`              | Aligned                                                        |
| Builder            | `Builder` class                         | `init(...)` with defaults            | Platform idiom: Kotlin uses builder, Swift uses default params |

## 3. Navigation

| API                  | Android         | iOS                                | Notes                                                                                    |
| -------------------- | --------------- | ---------------------------------- | ---------------------------------------------------------------------------------------- |
| `NavigationEvent`    | data class      | struct                             | Aligned fields: destination, timestamp, source, arguments, metadata                      |
| `NavigationListener` | interface       | protocol (class-bound)             | Aligned                                                                                  |
| `NavigationSource`   | enum (6 values) | enum `NavigationSource` (4 values) | Platform-specific sources; see below. (iOS wire discriminator is `NavigationSourceType`) |

**Platform-specific navigation sources (correctly different):**

- Android: `NAVIGATION_COMPONENT`, `COMPOSE_NAVIGATION`, `CIRCUIT`, `CUSTOM`, `DEEP_LINK`, `ACTIVITY`
- iOS: `swiftUINavigation`, `uiKitNavigation`, `deepLink`, `custom`

## 4. Biometrics

| API               | Android (`AutoMobileBiometrics`)        | iOS (`AutoMobileBiometrics`)                    | Notes                                         |
| ----------------- | --------------------------------------- | ----------------------------------------------- | --------------------------------------------- |
| Singleton         | `INSTANCE` (object)                     | `shared` (static let)                           | Platform idiom                                |
| `initialize`      | `initialize(Context)`                   | --                                              | iOS needs no Context; no explicit init needed |
| `overrideResult`  | `overrideResult(BiometricResult, Long)` | `overrideResult(BiometricResult, ttlMs: Int64)` | Aligned (Kotlin `Long` / Swift `Int64`)       |
| `consumeOverride` | `consumeOverride()`                     | `consumeOverride()`                             | Aligned                                       |
| `clearOverride`   | `clearOverride()`                       | `clearOverride()`                               | Aligned                                       |
| `hasOverride`     | `hasOverride` (property)                | `hasOverride` (property)                        | Aligned                                       |

`BiometricResult` variants: `Success`, `Failure`, `Cancel`, `Error(code, message)` -- aligned on both platforms.

## 5. Breadcrumbs

| API                                          | Android         | iOS             | Notes                                                     |
| -------------------------------------------- | --------------- | --------------- | --------------------------------------------------------- |
| `BreadcrumbCategory`                         | enum (6 values) | enum (6 values) | Aligned: navigation, tap, lifecycle, network, log, custom |
| `Breadcrumb`                                 | data class      | struct          | Aligned fields: timestamp, category, message, metadata    |
| `BreadcrumbTracking`                         | interface       | protocol        | Aligned: add, snapshot, clear                             |
| `BreadcrumbTrail`                            | class           | class           | Aligned                                                   |
| `writeToDisk` / `loadFromDisk` / `clearDisk` | --              | iOS-only        | iOS persists breadcrumbs to disk for crash resilience     |

## 6. Crashes

| API                     | Android (`AutoMobileCrashes`) | iOS (`AutoMobileCrashes`)      | Notes                                                    |
| ----------------------- | ----------------------------- | ------------------------------ | -------------------------------------------------------- |
| `initialize`            | `initialize(Context)`         | `initialize(bundleId:buffer:)` | Internal on both                                         |
| `isInitialized`         | `isInitialized()`             | `isInitialized` (property)     | Aligned                                                  |
| `currentScreenProvider` | property                      | property                       | Aligned                                                  |
| `uninstall`             | `uninstall()`                 | --                             | Android-only; iOS uses `reset()` internally              |
| `enableSignalHandlers`  | --                            | `enableSignalHandlers()`       | iOS-only: POSIX signal handlers for SIGABRT/SIGSEGV etc. |
| `breadcrumbTrail`       | property (assignable)         | --                             | Android wires breadcrumbs to crashes; iOS could add this |

## 7. Failures (Handled Exceptions)

| API                      | Android (`AutoMobileFailures`)               | iOS (`AutoMobileFailures`)                                | Notes                                      |
| ------------------------ | -------------------------------------------- | --------------------------------------------------------- | ------------------------------------------ |
| `recordHandledException` | `recordHandledException(Throwable, String?)` | `recordHandledException(Error, message:, currentScreen:)` | Aligned concept; types differ per platform |
| `getRecentEvents`        | `getRecentEvents()`                          | `getRecentEvents()`                                       | Aligned                                    |
| `clearEvents`            | `clearEvents()`                              | `clearEvents()`                                           | Aligned                                    |
| `eventCount`             | `getEventCount()`                            | `eventCount` (property)                                   | Aligned                                    |

## 8. Logging

| API                                           | Android (`AutoMobileLog`)      | iOS (`AutoMobileLog`)            | Notes                                                              |
| --------------------------------------------- | ------------------------------ | -------------------------------- | ------------------------------------------------------------------ |
| Log levels                                    | `v`, `d`, `i`, `w`, `e`, `wtf` | `v`, `d`, `i`, `w`, `e`, `fault` | `wtf` (Android) vs `fault` (iOS) -- platform idiom                 |
| `addFilter` / `removeFilter` / `clearFilters` | Yes                            | --                               | Android-only log filtering; iOS uses os.Logger subsystem filtering |
| Throwable overloads                           | `v(tag, msg, Throwable)` etc.  | --                               | Android has error-chaining overloads; iOS relies on os.Logger      |

## 9. Network

| API                     | Android (`AutoMobileNetwork`) | iOS (`AutoMobileNetwork`)               | Notes                                                                                                                                                                                     |
| ----------------------- | ----------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `interceptor`           | `interceptor()` (OkHttp)      | --                                      | Android-only: OkHttp interceptor                                                                                                                                                          |
| `protocolClass`         | --                            | `protocolClass()` (URLProtocol)         | iOS-only: URLSession protocol                                                                                                                                                             |
| `recordRequest`         | --                            | `recordRequest(...)`                    | iOS manual recording; Android uses interceptor                                                                                                                                            |
| `captureRecorder`       | --                            | `captureRecorder()`                     | iOS transport-neutral lifecycle recorder for custom HTTP, WebSocket, and Network.framework adapters                                                                                       |
| `recordWebSocketFrame`  | --                            | `recordWebSocketFrame(...)`             | iOS manual; Android wraps listener                                                                                                                                                        |
| `wrapWebSocketListener` | `wrapWebSocketListener(...)`  | --                                      | Android-only                                                                                                                                                                              |
| `setCaptureHeaders`     | --                            | `setCaptureHeaders(Bool)`               | iOS-only config                                                                                                                                                                           |
| `setCaptureBodies`      | --                            | `setCaptureBodies(Bool)`                | iOS-only config                                                                                                                                                                           |
| `setMaxBodyBytes`       | --                            | `setMaxBodyBytes(Int)`                  | iOS-only config                                                                                                                                                                           |
| `setEnabled`            | --                            | `setEnabled(Bool)`                      | iOS-only toggle                                                                                                                                                                           |
| `NetworkMockRuleStore`  | Yes (with BroadcastReceiver)  | Yes (via CtrlProxy relay to SDK server) | Mock rules and error simulation; iOS requires sessions to register `protocolClass()` and error simulation requires the supporting iOS CtrlProxy runner release or a local runner override |

**Why these differ:** Network interception is inherently platform-specific. Android uses OkHttp interceptors; iOS uses URLProtocol. Mock-rule and error-simulation transport also differs: Android uses broadcast intents, while iOS relays through CtrlProxy to the SDK server.

## 10. ANR / Hang Detection

| API                                  | Android (`AutoMobileAnr`) | iOS (`AutoMobileHangs`)                  | Notes                                                          |
| ------------------------------------ | ------------------------- | ---------------------------------------- | -------------------------------------------------------------- |
| **Correctly different names**        | `AutoMobileAnr`           | `AutoMobileHangs`                        | ANR is Android terminology; "hang" is the iOS/Apple equivalent |
| `initialize`                         | `initialize(Context)`     | `initialize(bundleId:buffer:)`           | Internal                                                       |
| `isAvailable`                        | `isAvailable()`           | --                                       | Android-only (checks if ANR detection is supported)            |
| `startMonitoring` / `stopMonitoring` | --                        | `startMonitoring()` / `stopMonitoring()` | iOS manages watchdog thread directly                           |
| `isMonitoring`                       | --                        | `isMonitoring` (property)                | iOS-only                                                       |
| `hangThresholdMs` / `pollIntervalMs` | --                        | public properties                        | iOS-only configuration                                         |
| `setEnabled`                         | --                        | `setEnabled(Bool)`                       | iOS-only toggle                                                |

## 11. OS Events

| API            | Android (`AutoMobileOsEvents`)                           | iOS (`AutoMobileOsEvents`)                              | Notes                       |
| -------------- | -------------------------------------------------------- | ------------------------------------------------------- | --------------------------- |
| Events tracked | Activity lifecycle, battery, connectivity, screen on/off | App lifecycle, battery, connectivity, screen brightness | Platform-appropriate events |
| `setEnabled`   | --                                                       | `setEnabled(Bool)`                                      | iOS-only toggle             |

## 12. Interaction Tracking

| API                           | Android (`AutoMobileClickTracker`) | iOS (`AutoMobileInteractionTracker`) | Notes                                                                         |
| ----------------------------- | ---------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------- |
| **Correctly different names** | `AutoMobileClickTracker`           | `AutoMobileInteractionTracker`       | Android auto-instruments via Window.Callback; iOS requires manual `recordTap` |
| `initialize`                  | internal                           | internal                             | Aligned                                                                       |
| `setEnabled`                  | --                                 | `setEnabled(Bool)`                   | iOS-only                                                                      |
| `recordTap`                   | --                                 | `recordTap(x:y:...)`                 | iOS manual tracking                                                           |

## 13. Notifications

| API                    | Android (`AutoMobileNotifications`)                       | iOS (`AutoMobileNotifications`)                        | Notes                                                |
| ---------------------- | --------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------- |
| `post`                 | `post(title, body, style, imagePath, actions, channelId)` | `post(title:body:style:imagePath:actions:categoryId:)` | Aligned; `channelId` (Android) vs `categoryId` (iOS) |
| `installActionHandler` | --                                                        | `installActionHandler(on:)`                            | iOS-only: installs UNUserNotificationCenterDelegate  |
| Broadcast actions      | via BroadcastReceiver intents                             | via NotificationCenter posts                           | Platform idiom                                       |

## 14. Storage Inspection

| API                           | Android (`SharedPreferencesInspector`) | iOS (`UserDefaultsInspector`)                | Notes                                             |
| ----------------------------- | -------------------------------------- | -------------------------------------------- | ------------------------------------------------- |
| **Correctly different names** | `SharedPreferencesInspector`           | `UserDefaultsInspector`                      | SharedPreferences (Android) vs UserDefaults (iOS) |
| `isEnabled`                   | `isEnabled` (property)                 | `isEnabled` (property)                       | Aligned                                           |
| `setEnabled`                  | `setEnabled(Boolean)`                  | `setEnabled(Bool)`                           | Aligned                                           |
| `getDriver`                   | `getDriver()` (internal)               | `getDriver()`                                | iOS public                                        |
| Change listeners              | via `SharedPreferencesDriver`          | `addChangeListener` / `removeChangeListener` | Aligned concept                                   |

## 15. Database Inspection

| API              | Android (`DatabaseInspector`) | iOS (`DatabaseInspector`)                         | Notes                                                       |
| ---------------- | ----------------------------- | ------------------------------------------------- | ----------------------------------------------------------- |
| `isEnabled`      | `isEnabled` (property)        | `isEnabled` (property)                            | Aligned                                                     |
| `setEnabled`     | `setEnabled(Boolean)`         | `setEnabled(Bool)`                                | Aligned                                                     |
| `getDriver`      | `getDriver()` (internal)      | `getDriver()`                                     | Aligned                                                     |
| `closeAll`       | `closeAll()`                  | --                                                | Android-only                                                |
| Driver interface | `DatabaseDriver`              | `DatabaseDriver`                                  | Aligned methods                                             |
| Host access      | ContentProvider bridge        | DEBUG in-app SDK HTTP server relayed by CtrlProxy | `sqlQuery` and database resources share the same JSON shape |

## 16. Compose / SwiftUI View Tracking

| API                           | Android (`RecompositionTracker`)                         | iOS (`ViewBodyTracker`)        | Notes                |
| ----------------------------- | -------------------------------------------------------- | ------------------------------ | -------------------- |
| **Correctly different names** | Tracks Compose recomposition                             | Tracks SwiftUI body evaluation | Platform idiom       |
| `isEnabled` / `setEnabled`    | Yes                                                      | Yes                            | Aligned              |
| Compose-specific              | `TrackRecomposition`, `autoMobileRecomposition` modifier | `TrackViewBody` modifier       | Platform idiom       |
| `EnableComposeObservableApi`  | Yes                                                      | --                             | Android Compose-only |

## 17. Session Tracking

| API                             | Android (`SessionTracker`) | iOS (`SessionTracker`) | Notes   |
| ------------------------------- | -------------------------- | ---------------------- | ------- |
| `SessionTracking`               | interface                  | protocol               | Aligned |
| `currentSessionId`              | `currentSessionId()`       | `currentSessionId()`   | Aligned |
| `onForeground` / `onBackground` | Yes                        | Yes                    | Aligned |
| `shutdown`                      | `shutdown()`               | `shutdown()`           | Aligned |

## 18. Event System

| API                          | Android                        | iOS                            | Notes                                        |
| ---------------------------- | ------------------------------ | ------------------------------ | -------------------------------------------- |
| `SdkEvent`                   | interface                      | protocol                       | Aligned                                      |
| `SdkEventBuffer`             | class                          | class                          | Aligned: `add`, `flush`, `start`, `shutdown` |
| `EventProcessor`             | interface                      | `EventProcessing` protocol     | Aligned concept                              |
| `DropCounter` / `DropReason` | interface + enum               | `DropCounting` protocol + enum | Aligned                                      |
| `EventPersistence`           | interface                      | `EventPersisting` protocol     | Aligned                                      |
| `SdkEventBroadcaster`        | broadcasts via Android Intents | broadcasts via persistence     | Platform-specific delivery                   |
| `RetryPolicy`                | data class                     | struct                         | Aligned                                      |

---

## Platform-Specific APIs (Correctly Different)

These APIs exist on only one platform due to inherent platform differences:

### Android-Only

- `ComposeObservableApi` / `EnableComposeObservableApi` -- Jetpack Compose observation hooks
- `autoMobileRecomposition` / `autoMobileRecompositionId` modifiers -- Compose semantics
- `CircuitAdapter`, `Navigation3Adapter` -- Android navigation framework adapters
- `SdkConstants` (CTRL_PROXY_PACKAGE, PERMISSION_NETWORK_CONTROL) -- Android IPC
- `ConfigurationOverrideHelper` -- Android Configuration override for testing
- Network mock delivery -- Android uses BroadcastReceiver IPC
- `AutoMobileNetworkInterceptor` / `AutoMobileWebSocketListener` -- OkHttp specific

### iOS-Only

- `AutoMobileURLProtocol` -- URLSession interception
- Network mock delivery -- iOS uses CtrlProxy relay to the SDK server
- `BreadcrumbTrail.writeToDisk` / `loadFromDisk` / `clearDisk` -- Disk persistence for crash resilience
- `AutoMobileCrashes.enableSignalHandlers` -- POSIX signal handler installation
- `SwiftUINavigationAdapter` -- SwiftUI navigation tracking
- `NavigationFrameworkAdapter` protocol -- Pluggable navigation framework support
- `AutoMobileNotificationObserver` -- Notification.Name observation (vs Android BroadcastReceiver)

---

## Summary of Gaps Fixed

| Gap                                                 | Platform | Resolution                         |
| --------------------------------------------------- | -------- | ---------------------------------- |
| Missing `addBreadcrumb(message:category:metadata:)` | iOS      | Added to `AutoMobileSDK.swift`     |
| Missing `shutdown()`                                | iOS      | Added to `AutoMobileSDK.swift`     |
| Missing `hasOverride` property                      | Android  | Added to `AutoMobileBiometrics.kt` |
