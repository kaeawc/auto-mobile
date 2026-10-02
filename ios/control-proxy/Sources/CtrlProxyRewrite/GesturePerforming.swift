import Foundation

public struct PressKeyOutcome: Sendable {
    public let verified: Bool?
    public let warning: String?

    public init(verified: Bool?, warning: String? = nil) {
        self.verified = verified
        self.warning = warning
    }
}

/// Performs gestures and interactions via XCUITest.
///
/// `@MainActor` — same archetype as `ElementLocating`. Every method ultimately drives
/// XCUITest, which must run on the main thread. The reference hopped onto main per call
/// with `DispatchQueue.main.sync` (`runOnMainThread`) and left the protocol un-isolated;
/// isolating the whole protocol to the main actor removes the per-call hop and lets a
/// `Sendable` `CommandHandler` (Phase 6) `await` these from off the main actor.
@MainActor
public protocol GesturePerforming: Sendable {
    /// Non-key commands break the consecutive verified-key sequence.
    func invalidateCaretMemo()

    // MARK: - Tap Gestures

    /// Tap at coordinates with optional duration for long press
    func tap(x: Double, y: Double, duration: TimeInterval) throws

    /// Opt-in seam: existing conformers retain their plain tap through the default implementation.
    /// The live performer overrides this to sample immediately before delivery, inside its guard.
    func tapWithDiagnostics(x: Double, y: Double, durationMs: Int) throws -> TapDiagnostics

    /// Double tap at coordinates
    func doubleTap(x: Double, y: Double) throws

    /// Long press at coordinates
    func longPress(x: Double, y: Double, duration: TimeInterval) throws

    // MARK: - Swipe Gestures

    /// Swipe from start to end coordinates
    func swipe(startX: Double, startY: Double, endX: Double, endY: Double, duration: TimeInterval) throws

    /// Opt-in lock-screen seam; older conformers retain the ordinary swipe.
    func lockScreenSwipe(startX: Double, startY: Double, endX: Double, endY: Double, duration: TimeInterval) throws

    /// Perform a simultaneous multi-finger swipe from start to end coordinates
    func multiFingerSwipe(
        startX: Double,
        startY: Double,
        endX: Double,
        endY: Double,
        fingerCount: Int,
        fingerSpacing: Double,
        duration: TimeInterval
    )
        throws

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

    /// Pinch at center with explicit starting and ending finger distances.
    /// Returns which mechanism performed the gesture: the private event-path
    /// synthesis (honors center) or the public element-anchored fallback
    /// (center-less). See issue #2910.
    @discardableResult
    func pinch(
        centerX: Double,
        centerY: Double,
        distanceStart: Double,
        distanceEnd: Double,
        rotationDegrees: Double,
        duration: TimeInterval
    )
        throws -> PinchGesturePath

    // MARK: - Text Input

    /// Type text using keyboard
    func typeText(text: String) throws

    /// Insert text at the current caret without clearing or retargeting a field.
    func appendText(text: String) throws

    /// Set text on a specific element
    func setText(resourceId: String, text: String) async throws

    /// Clear text from element or focused field
    func clearText(resourceId: String?) async throws

    /// Select all text
    func selectAll() throws

    /// Perform IME action (done, next, search, etc.)
    func performImeAction(_ action: String) throws

    /// Open, close, or detect the software keyboard. Returns whether the
    /// keyboard is visible after the requested action.
    /// Returns true when caret movement was checked, false when it could not be checked,
    /// and nil for keys without a caret post-condition.
    func pressKey(key: String, modifiers: [String]) async throws -> Bool?
    func pressKeyOutcome(key: String, modifiers: [String]) async throws -> PressKeyOutcome
    func keyboard(action: String) async throws -> KeyboardActionResult

    // MARK: - Clipboard

    /// Perform clipboard operation (get, copy, clear, paste)
    func clipboard(action: String, text: String?) throws -> String?

    // MARK: - Actions

    /// Perform action on element by resourceId or label (content-desc)
    func performAction(
        _ action: String,
        resourceId: String?,
        label: String?,
        bounds: ElementBounds?,
        duration: Int?
    ) throws
    func activateAccessibilityLink(text: String, occurrence: Int, ownerResourceId: String?) throws

    // MARK: - Screenshots

    /// Capture screenshot
    func getScreenshot() throws -> Data

    /// Capture a screenshot with its device rotation provenance.
    func getScreenshotCapture() throws -> ScreenshotCapture

    // MARK: - Device Control

    /// Set device orientation
    func setOrientation(_ orientation: String) throws

    /// Get current orientation
    func getOrientation() -> String

    /// Get the current display rotation as Android-compatible 0...3, if available.
    func getDisplayRotation() -> Int?

    /// Press home button
    func pressHome() throws

    /// Perform app-level back navigation
    func pressBack() throws

    /// Generate a synthetic shake motion event.
    func shake() throws

    /// Press a named hardware or keyboard-backed button.
    func pressButton(_ button: String) throws

    /// Open recent apps (app switcher) and return whether the switcher was verified.
    func openRecentApps() throws -> Bool

    // MARK: - App Control

    /// Launch app by bundle ID
    func launchApp(bundleId: String) throws

    /// Terminate app by bundle ID
    func terminateApp(bundleId: String) throws

    /// Activate app by bundle ID
    func activateApp(bundleId: String) throws

    /// Update the internal application reference for gesture operations.
    func updateApplication(bundleId: String)

    // MARK: - App Privacy Permissions

    /// Reset privacy authorizations for the given app back to the not-determined
    /// ("ask next time") state via `XCUIApplication.resetAuthorizationStatus(for:)`.
    /// Each entry in `resources` is an AutoMobile permission name mapped to an
    /// `XCUIProtectedResource`; `all` expands to every resettable resource, while
    /// an unmapped name throws so the caller can surface a per-permission failure.
    /// Works on physical devices, not just simulators. (#2491/#3133)
    func resetAuthorizations(bundleId: String, resources: [String]) throws
}

extension GesturePerforming {
    public func invalidateCaretMemo() {}

    public func lockScreenSwipe(
        startX: Double, startY: Double, endX: Double, endY: Double, duration: TimeInterval
    )
        throws
    {
        try swipe(startX: startX, startY: startY, endX: endX, endY: endY, duration: duration)
    }

    public func tapWithDiagnostics(x: Double, y: Double, durationMs: Int) throws -> TapDiagnostics {
        try tap(x: x, y: y, duration: TimeInterval(durationMs) / 1000.0)
        return TapDiagnostics(
            requested: .init(x: x, y: y, durationMs: durationMs),
            sampleErrors: ["sampler: unavailable for this GesturePerforming implementation"]
        )
    }

    public func pressKeyOutcome(key: String, modifiers: [String]) async throws -> PressKeyOutcome {
        try await PressKeyOutcome(verified: pressKey(key: key, modifiers: modifiers))
    }

    public func getScreenshotCapture() throws -> ScreenshotCapture {
        let rotationBeforeCapture = getDisplayRotation()
        let data = try getScreenshot()
        let rotationAfterCapture = getDisplayRotation()
        return ScreenshotCapture(
            data: data,
            rotation: rotationBeforeCapture == rotationAfterCapture ? rotationAfterCapture : nil
        )
    }

    public func getDisplayRotation() -> Int? {
        DeviceRotation.fromOrientationName(getOrientation())
    }
}

/// The tracked app cannot identify a locked screen reliably; only the explicit wire flag can.
enum SwipeDispatchMode: Equatable {
    case xcuitest
    case synthesizedLockScreen
}

func swipeDispatchMode(lockScreen: Bool?) -> SwipeDispatchMode {
    lockScreen == true ? .synthesizedLockScreen : .xcuitest
}
