# AutoMobile SDK

Android library SDK for tracking navigation events across various navigation frameworks including Navigation3, Jetpack Compose Navigation, Circuit, and custom solutions.

## Features

- Universal navigation event tracking across multiple frameworks
- Navigation3 (androidx.navigation3) support
- Circuit navigation support
- Manual tracking for custom navigation solutions
- Simple listener-based API
- Debug-only notification posting for automated test scenarios
- Maven Central publishing ready

## Installation

### Gradle (Kotlin DSL)

```kotlin
dependencies {
    implementation("dev.jasonpearson.auto-mobile:auto-mobile-sdk:0.0.1-SNAPSHOT")
}
```

### Gradle (Groovy DSL)

```groovy
dependencies {
    implementation 'dev.jasonpearson.auto-mobile:auto-mobile-sdk:0.0.1-SNAPSHOT'
}
```

## Usage

### Navigation3 Integration

For apps using androidx.navigation3, add tracking calls in your `NavDisplay` entry providers:

```kotlin
@Composable
fun AppNavigation() {
    val backStack = rememberNavBackStack(startDestination)

    // Register a navigation listener
    LaunchedEffect(Unit) {
        AutoMobileSDK.addNavigationListener { event ->
            Log.d("Navigation", "Navigated to: ${event.destination}")
            // Handle navigation event
        }
    }

    NavDisplay(
        backStack = backStack,
        onBack = { backStack.removeLastOrNull() },
        entryProvider = entryProvider {
            entry<HomeDestination> { homeDestination ->
                // Track navigation with arguments extraction
                Navigation3Adapter.TrackNavigation(
                    destination = homeDestination,
                    extractArguments = {
                        mapOf(
                            "selectedTab" to it.selectedTab,
                            "selectedSubTab" to it.selectedSubTab
                        )
                    }
                )

                HomeScreen(...)
            }

            entry<SettingsDestination> { destination ->
                // Simple tracking without arguments
                Navigation3Adapter.TrackNavigation(destination)

                SettingsScreen(...)
            }
        }
    )
}
```

### Circuit Integration

For automatic Circuit destination tracking, add CircuitX Navigation to your application:

```kotlin
dependencies {
    implementation("com.slack.circuit:circuitx-navigation:0.35.1")
}
```

Create the AutoMobile listener and add it to your existing CircuitX navigator wrapper:

```kotlin
@Composable
fun App() {
    val autoMobileListener =
        CircuitAdapter.rememberCircuitNavigationEventListener(
            extractArguments = { screen -> screen.autoMobileArguments() },
            extractMetadata = { screen -> screen.autoMobileMetadata() },
        )

    val navigator =
        rememberInterceptingNavigator(
            navigator = baseNavigator,
            interceptors = interceptors,
            eventListeners = existingListeners + autoMobileListener,
        )

    NavigableCircuitContent(navigator, navStack)
}
```

The listener records the initial active screen and later committed stack mutations. It records the
final active screen after an interceptor rewrites a navigation operation, and does not emit a
destination for a consumed operation that leaves the stack unchanged.

Register a listener with every independent or nested `InterceptingNavigator` whose destinations
you want to track. The SDK keeps CircuitX optional, so the application provides the CircuitX
dependency and chooses its version.

Use manual tracking for plain `rememberCircuitNavigator(...)` instances, destinations outside the
Circuit stack, or presentation-lifecycle events:

```kotlin
// Start the adapter once during application initialization.
CircuitAdapter.start()

// Track a Circuit screen while preserving its type-derived destination name.
CircuitAdapter.trackScreen(
    screen = profileScreen,
    arguments = mapOf("userId" to userId),
)

// Track a destination that is not represented by a Circuit Screen.
CircuitAdapter.trackNavigation(
    destination = "ExternalProfile",
    arguments = mapOf("userId" to userId),
)
```

CircuitX listeners do not observe plain Circuit navigators, consumed drawer or overlay operations,
legacy fragments or activities, custom tabs, external intents, or a screen's visual-settled state
after an animation. Track those destinations at the layer that presents them.

### Manual Tracking

For custom navigation solutions:

```kotlin
// Start tracking
Navigation3Adapter.start()

// Track navigation manually
Navigation3Adapter.trackManually(
    destinationName = "CustomScreen",
    arguments = mapOf("param1" to "value1"),
    metadata = mapOf("transition" to "slide")
)

// Stop tracking
Navigation3Adapter.stop()
```

### Notifications (debug-only)

Post rich notifications as the app-under-test from debug builds:

```kotlin
AutoMobileSDK.initialize(applicationContext)

AutoMobileNotifications.post(
    title = "Welcome",
    body = "This is a test notification",
    style = NotificationStyle.BIG_TEXT,
    imagePath = "/sdcard/Download/automobile/sample.png",
    actions = listOf(NotificationAction(label = "Open", actionId = "open_action"))
)
```

Notes:
- The AutoMobile MCP server uses a debug-only broadcast receiver to trigger notifications.
- Release builds do not include the receiver; SDK integration is required for app-under-test notifications.
- The MCP tool uploads host images to `/sdcard/Download/automobile/` before posting big-picture notifications.

## API Reference

### AutoMobileSDK

Main SDK class for registering navigation listeners and discovering the host integration's
capabilities and policy.

```kotlin
// Add a navigation listener
AutoMobileSDK.addNavigationListener { event ->
    // Handle navigation event
}

// Remove a specific listener
AutoMobileSDK.removeNavigationListener(listener)

// Clear all listeners
AutoMobileSDK.clearNavigationListeners()

// Enable/disable tracking
AutoMobileSDK.setEnabled(true)

// Check if tracking is enabled
val isEnabled = AutoMobileSDK.isTrackingEnabled

// Get listener count
val count = AutoMobileSDK.listenerCount

// Discover available SDK capabilities and their reasons when unavailable.
val capabilities = AutoMobileSDK.capabilities

// Register an optional host hook, such as a storage mutation driver.
AutoMobileSDK.registerCapability(
    SdkCapabilityDescriptor("storage.mutation", SdkCapabilityState.SUPPORTED)
)

// Sensitive capture and mutation access is opt-in and validated atomically.
AutoMobileSDK.updateCapturePolicy(
    SdkCapturePolicy(captureHeaders = true, captureBodies = true)
)
```

Capability snapshots are versioned and distinguish `NOT_INITIALIZED`, `DISABLED`, `UNSUPPORTED`,
`PERMISSION_DENIED`, and `SUPPORTED`. Removing an optional capability restores its unsupported
descriptor and revokes any policy field that depends on it. Older clients should ignore unknown
capability fields and use the schema version to select compatible behavior.

### NavigationEvent

Data class representing a navigation event:

```kotlin
data class NavigationEvent(
    val destination: String,              // Destination name/route
    val timestamp: Long,                  // Event timestamp
    val source: NavigationSource,         // Navigation framework source
    val arguments: Map<String, Any?>,     // Navigation arguments
    val metadata: Map<String, String>     // Additional metadata
)
```

### NavigationSource

Enum identifying the navigation framework:

```kotlin
enum class NavigationSource {
    NAVIGATION_COMPONENT,  // XML-based Navigation Component
    COMPOSE_NAVIGATION,    // Compose/Navigation3
    CIRCUIT,               // Circuit navigation
    CUSTOM,                // Custom navigation
    DEEP_LINK,            // Deep link navigation
    ACTIVITY              // Activity launch
}
```

## Example: Analytics Integration

```kotlin
@Composable
fun AppNavigation() {
    val analyticsTracker = remember { AnalyticsTracker.getInstance() }

    LaunchedEffect(Unit) {
        AutoMobileSDK.addNavigationListener { event ->
            // Track to analytics
            analyticsTracker.trackScreenView(
                screenName = event.destination,
                parameters = event.arguments
            )

            // Log navigation for debugging
            Log.d("Navigation",
                "Screen: ${event.destination}, " +
                "Source: ${event.source}, " +
                "Args: ${event.arguments}"
            )
        }
    }

    // ... rest of navigation setup
}
```

## Example: Testing Integration

```kotlin
class NavigationTest {
    @Before
    fun setup() {
        AutoMobileSDK.clearNavigationListeners()
        AutoMobileSDK.setEnabled(true)
    }

    @Test
    fun `navigation events are tracked`() {
        val events = mutableListOf<NavigationEvent>()

        AutoMobileSDK.addNavigationListener { event ->
            events.add(event)
        }

        // Trigger navigation
        Navigation3Adapter.trackManually("TestScreen")

        // Verify
        assertEquals(1, events.size)
        assertEquals("TestScreen", events[0].destination)
    }
}
```

## Building from Source

```bash
cd android
./gradlew :auto-mobile-sdk:build
```

## Running Tests

```bash
./gradlew :auto-mobile-sdk:test
```

## Publishing

```bash
./gradlew :auto-mobile-sdk:publishToMavenCentral
```

## License

Apache License 2.0

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
