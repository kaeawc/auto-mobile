# ``AutoMobileSDK``

The AutoMobile iOS SDK provides navigation tracking, crash detection, hang monitoring, network inspection, and more for iOS applications.

## Overview

AutoMobileSDK is the main entry point for integrating the AutoMobile observability platform into your iOS app. It provides automatic and manual instrumentation for navigation events, crashes, hangs, network requests, user interactions, and system events.

Initialize the SDK early in your app lifecycle:

```swift
AutoMobileSDK.shared.initialize()
```

Or with a custom configuration:

```swift
let config = AutoMobileConfiguration(
    bufferSize: 100,
    flushIntervalMs: 1000,
    maxBreadcrumbs: 200
)
AutoMobileSDK.shared.initialize(configuration: config)
```

## Topics

### Essentials

- ``AutoMobileSDK``
- ``AutoMobileConfiguration``
- ``SdkContext``
- ``SdkContextSnapshot``
- ``AutoMobileObservationBridge``
- ``AutoMobileObservationProvider``
- ``AutoMobileActionExecutor``
- ``AutoMobileSerialActionQueue``

### Navigation

- ``NavigationEvent``
- ``NavigationSource``
- ``NavigationListener``
- ``BlockNavigationListener``
- ``NavigationFrameworkAdapter``
- ``SwiftUINavigationAdapter``
- ``UIKitNavigationAdapter``
- ``DeepLinkNavigationAdapter``
- ``CustomNavigationAdapter``
- ``NavigationAdapterHub``
- ``NavigationScreenIdentity``
- ``NavigationDataRedacting``
- ``NavigationEventFactory``
- ``TrackNavigationModifier``

### Crashes

- ``AutoMobileCrashes``

### Hangs

- ``AutoMobileHangs``

### Failures

- ``AutoMobileFailures``
- ``HandledExceptionEvent``

### Network

- ``AutoMobileNetwork``
- ``AutoMobileURLProtocol``
- ``AutoMobileWebViewBridge``
- ``AutoMobileWebViewConfiguration``
- ``AutoMobileWebSnapshot``
- ``AutoMobileWebAction``
- ``RetryPolicy``
- ``WebSocketFrameDirection``
- ``WebSocketFrameType``

### Logging

- ``AutoMobileLog``
- ``LogLevel``

### Biometrics

- ``AutoMobileBiometrics``
- ``BiometricResult``

### Events

- ``SdkEvent``
- ``SdkEventType``
- ``SdkEventBuffer``
- ``SdkEventEnvelope``
- ``SdkEventBatch``
- ``EventBuffering``
- ``EventProcessing``
- ``EventBroadcasting``
- ``SdkEventBroadcaster``

### Event Types

- ``SdkNavigationEvent``
- ``SdkHandledExceptionEvent``
- ``SdkCrashEvent``
- ``SdkHangEvent``
- ``SdkNetworkRequestEvent``
- ``SdkWebSocketFrameEvent``
- ``SdkLogEvent``
- ``SdkLifecycleEvent``
- ``SdkNotificationActionEvent``
- ``SdkViewBodySnapshotEvent``
- ``SdkBroadcastEvent``
- ``SdkInteractionEvent``
- ``SdkStorageChangedEvent``
- ``NavigationSourceType``

### Observation and Control

- ``AutoMobileObservationSnapshot``
- ``AutoMobileObservationNode``
- ``AutoMobileAction``
- ``AutoMobileActionResult``
- ``AutoMobileCoordinateSpace``
- ``AutoMobileDeviceOrientation``

### Drop Counting

- ``DropReason``
- ``DropCounting``
- ``DefaultDropCounter``

### Storage

- ``UserDefaultsInspector``
- ``UserDefaultsDriver``
- ``UserDefaultsSuiteDescriptor``
- ``KeyValuePair``
- ``KeyValueType``
- ``UserDefaultsChangeListener``
- ``DatabaseInspector``
- ``DatabaseDriver``
- ``SQLiteDatabaseDriver``
- ``DatabaseDescriptor``
- ``TableDataResult``
- ``TableStructureResult``
- ``ColumnInfo``
- ``SQLExecutionResult``

### Breadcrumbs

- ``BreadcrumbCategory``
- ``Breadcrumb``
- ``BreadcrumbTracking``
- ``BreadcrumbTrail``

### Notifications

- ``AutoMobileNotifications``
- ``NotificationStyle``
- ``NotificationAction``

### OS Events

- ``AutoMobileOsEvents``
- ``AutoMobileNotificationObserver``

### Interaction Tracking

- ``AutoMobileInteractionTracker``

### View Body Tracking

- ``ViewBodyTracker``
- ``ViewBodySnapshot``
- ``TrackViewBodyModifier``
- ``MeasureViewBody``

### Session Management

- ``SessionTracking``
- ``SessionTracker``

### Persistence

- ``EventPersisting``
- ``FileEventPersistence``

### Timer Abstraction

- ``TimerScheduling``
- ``GCDTimer``

### Device Info

- ``SdkDeviceInfo``

### Date Provider

- ``DateProvider``
- ``SystemDateProvider``
