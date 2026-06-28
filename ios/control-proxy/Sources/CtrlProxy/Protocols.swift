import Foundation

// MARK: - App State Expectations

/// Expected app state for bounded polling after state-changing operations.
public enum AppStateExpectation {
    /// App should be in foreground (XCUIApplication.State.rawValue >= 4)
    case foreground
    /// App should not be running (XCUIApplication.State.rawValue <= 1)
    case notRunning
    /// App should be in background (XCUIApplication.State.rawValue == 3)
    case background
}

/// Observed app lifecycle state, mirroring XCUIApplication.State.
public enum ObservedAppState {
    case unknown
    case notRunning
    case runningBackgroundSuspended
    case runningBackground
    case runningForeground
}

// MARK: - ElementLocator Protocol

/// Protocol for locating UI elements and building view hierarchies
public protocol ElementLocating {
    /// Get the full view hierarchy
    /// - Parameter disableAllFiltering: If true, skip hierarchy optimization and return raw hierarchy
    func getViewHierarchy(disableAllFiltering: Bool) throws -> ViewHierarchy

    /// Find element by resource ID / accessibility identifier
    func findElement(byResourceId resourceId: String) -> Any?

    /// Find element by text content
    func findElement(byText text: String) -> Any?

    /// Track a bundle ID so the foreground app detector can find it
    func trackObservedBundleId(_ bundleId: String)

    /// Explicitly switch the tracked foreground app to the given bundle ID.
    /// Called by CommandHandler after state-changing operations (launch, terminate, home).
    func switchForegroundApp(bundleId: String)

    /// Query the current lifecycle state of the app with the given bundle ID.
    func getAppState(bundleId: String) -> ObservedAppState

    /// Wait for the given bundle ID to reach the expected state.
    /// Uses bounded polling: up to 500ms with 50ms intervals (10 attempts max).
    /// Returns true if state was reached, false if timed out.
    func awaitAppState(bundleId: String, expectedState: AppStateExpectation) -> Bool

    /// Bundle ID of the currently tracked foreground app, or nil if none has
    /// been set yet. Used by GesturePerformer's text-input paths to resolve a
    /// fresh XCUIApplication at call time (see issue #1925) — this avoids the
    /// drift where an MCP-side `simctl launch` updates ElementLocator's tracker
    /// but leaves GesturePerformer pointing at a stale / empty app reference.
    var foregroundBundleId: String? { get }
}

// MARK: - GesturePerformer Protocol

/// Protocol for performing gestures and interactions
public protocol GesturePerforming {
    // MARK: - Tap Gestures

    /// Tap at coordinates with optional duration for long press
    func tap(x: Double, y: Double, duration: TimeInterval) throws

    /// Double tap at coordinates
    func doubleTap(x: Double, y: Double) throws

    /// Long press at coordinates
    func longPress(x: Double, y: Double, duration: TimeInterval) throws

    // MARK: - Swipe Gestures

    /// Swipe from start to end coordinates
    func swipe(startX: Double, startY: Double, endX: Double, endY: Double, duration: TimeInterval) throws

    // MARK: - Drag Gestures

    /// Drag with press, drag, and hold durations
    func drag(
        startX: Double, startY: Double,
        endX: Double, endY: Double,
        pressDuration: TimeInterval,
        dragDuration: TimeInterval,
        holdDuration: TimeInterval
    )
        throws

    // MARK: - Pinch Gestures

    /// Pinch at center with scale
    func pinch(centerX: Double, centerY: Double, scale: Double, duration: TimeInterval) throws

    // MARK: - Text Input

    /// Type text using keyboard
    func typeText(text: String) throws

    /// Set text on a specific element
    func setText(resourceId: String, text: String) throws

    /// Clear text from element or focused field
    func clearText(resourceId: String?) throws

    /// Select all text
    func selectAll() throws

    /// Perform IME action (done, next, search, etc.)
    func performImeAction(_ action: String) throws

    /// Open, close, or detect the software keyboard. Returns whether the
    /// keyboard is visible after the requested action.
    func keyboard(action: String) throws -> Bool

    // MARK: - Clipboard

    /// Perform clipboard operation (get, copy, clear, paste)
    func clipboard(action: String, text: String?) throws -> String?

    // MARK: - Actions

    /// Perform action on element by resourceId or label (content-desc)
    func performAction(_ action: String, resourceId: String?, label: String?) throws

    // MARK: - Screenshots

    /// Capture screenshot
    func getScreenshot() throws -> Data

    // MARK: - Device Control

    /// Set device orientation
    func setOrientation(_ orientation: String) throws

    /// Get current orientation
    func getOrientation() -> String

    /// Press home button
    func pressHome() throws

    /// Perform app-level back navigation
    func pressBack() throws

    /// Generate a synthetic shake motion event.
    func shake() throws

    /// Press a named hardware or keyboard-backed button.
    func pressButton(_ button: String) throws

    /// Open recent apps (app switcher) via swipe-up-and-hold gesture
    func openRecentApps() throws

    // MARK: - App Control

    /// Launch app by bundle ID
    func launchApp(bundleId: String) throws

    /// Terminate app by bundle ID
    func terminateApp(bundleId: String) throws

    /// Activate app by bundle ID
    func activateApp(bundleId: String) throws

    /// Update the internal application reference for gesture operations.
    func updateApplication(bundleId: String)
}

// MARK: - StorageInspecting Protocol

/// Protocol for inspecting key-value storage (UserDefaults on iOS)
public protocol StorageInspecting {
    /// List available storage suites
    func listSuites() -> [StorageSuiteInfo]

    /// Get all entries from a suite
    func getEntries(suiteName: String?) -> [StorageEntry]

    /// Get a single entry by key
    func getEntry(suiteName: String?, key: String) -> StorageEntry?

    /// Set an entry value
    func setEntry(suiteName: String?, key: String, value: String?, type: String) throws

    /// Remove an entry by key
    func removeEntry(suiteName: String?, key: String) throws

    /// Clear all entries in a suite
    func clearEntries(suiteName: String?) throws
}

// MARK: - WebSocket Server Protocol

/// Protocol for WebSocket server operations
public protocol WebSocketServing {
    /// Whether the server is running
    var isRunning: Bool { get }

    /// Start the server
    func start() throws

    /// Stop the server
    func stop()

    /// Broadcast data to all connected clients
    func broadcast(_ data: Data)
}

// MARK: - Command Handler Protocol

/// Protocol for handling WebSocket commands
public protocol CommandHandling {
    /// Handle a request and return response
    func handle(_ request: WebSocketRequest) -> Any
}

// MARK: - SDK Hierarchy Protocols

/// Protocol for fetching SDK view hierarchy on demand from the target app.
public protocol SdkHierarchyFetching {
    /// Fetch the latest cached hierarchy (fast).
    func fetchHierarchy() -> SdkViewHierarchy?
    /// Request a fresh hierarchy walk (slower).
    func fetchFreshHierarchy() -> SdkViewHierarchy?
    /// Fetch lightweight server metadata, including the owning app bundle ID.
    func fetchServerInfo() -> SdkHierarchyServerInfo?
    /// Whether the SDK hierarchy server is reachable.
    func isAvailable() -> Bool
}

/// Protocol for accessing the cached SDK hierarchy.
public protocol SdkHierarchyCaching {
    /// The latest cached SDK view hierarchy, or nil if none received yet.
    var latest: SdkViewHierarchy? { get }
    /// Update the cached hierarchy.
    func update(_ hierarchy: SdkViewHierarchy)
    /// Clear the cached hierarchy.
    func clear()
}
