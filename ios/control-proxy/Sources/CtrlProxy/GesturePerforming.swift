import Foundation

public struct PressKeyOutcome: Sendable {
    public let verified: Bool?
    public let warning: String?

    public init(verified: Bool?, warning: String? = nil) {
        self.verified = verified
        self.warning = warning
    }
}

@MainActor
public protocol GesturePerforming: Sendable {
    /// Non-key commands break the consecutive verified-key sequence.
    func invalidateCaretMemo()

    // MARK: - Tap Gestures

    /// Deliver the complete double tap as one native coordinate gesture.
    func doubleTap(x: Double, y: Double) throws

    /// Tap at coordinates with optional duration for long press
    func tap(x: Double, y: Double, duration: TimeInterval) throws

    /// Opt-in seam: existing conformers retain their plain tap through the default implementation.
    /// The live performer overrides this to sample immediately before delivery, inside its guard.
    func tapWithDiagnostics(x: Double, y: Double, durationMs: Int) throws -> TapDiagnostics

    func tap(x: Double, y: Double, duration: TimeInterval, strategy: String?) throws
    func tapWithDiagnostics(x: Double, y: Double, durationMs: Int, strategy: String?) throws -> TapDiagnostics

    // MARK: - Swipe Gestures

    /// Swipe from start to end coordinates
    func swipe(startX: Double, startY: Double, endX: Double, endY: Double, duration: TimeInterval) throws

    /// Opt-in lock-screen seam; older conformers retain the ordinary swipe.
    func lockScreenSwipe(startX: Double, startY: Double, endX: Double, endY: Double, duration: TimeInterval) throws

    /// `swipe` that also reports which dispatch route ran and the stroke duration it really used
    /// (#13145). Conformers that cannot tell return nil, and the response omits the fields.
    func swipeReportingRoute(
        startX: Double, startY: Double, endX: Double, endY: Double, duration: TimeInterval
    ) throws -> SwipeDispatchReport?

    /// Lock-screen counterpart of `swipeReportingRoute`.
    func lockScreenSwipeReportingRoute(
        startX: Double, startY: Double, endX: Double, endY: Double, duration: TimeInterval
    ) throws -> SwipeDispatchReport?

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

    // MARK: - Path Gestures

    /// One finger down at the first point, through each later point at its offset, then up.
    func path(points: [PathGesturePoint]) throws

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
    func pressButton(_ button: String) async throws

    /// Open recent apps (app switcher) and return whether the switcher was verified.
    func openRecentApps() async throws -> Bool
    func openRecentAppsReportingRoute() async throws -> RecentAppsOutcome

    // MARK: - App Control

    /// Launch app by bundle ID
    func launchApp(bundleId: String) throws

    /// Terminate app by bundle ID
    func terminateApp(bundleId: String) throws

    /// Activate app by bundle ID
    func activateApp(bundleId: String) throws

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

public struct RecentAppsOutcome: Sendable {
    public let visible: Bool
    public let route: String?

    public init(visible: Bool, route: String? = nil) {
        self.visible = visible
        self.route = route
    }
}

extension GesturePerforming {
    public func openRecentAppsReportingRoute() async throws -> RecentAppsOutcome {
        let visible = try await openRecentApps()
        return RecentAppsOutcome(visible: visible)
    }

    public func invalidateCaretMemo() {}

    public func lockScreenSwipe(
        startX: Double, startY: Double, endX: Double, endY: Double, duration: TimeInterval
    )
        throws
    {
        try swipe(startX: startX, startY: startY, endX: endX, endY: endY, duration: duration)
    }

    public func swipeReportingRoute(
        startX: Double, startY: Double, endX: Double, endY: Double, duration: TimeInterval
    )
        throws -> SwipeDispatchReport?
    {
        try swipe(startX: startX, startY: startY, endX: endX, endY: endY, duration: duration)
        return nil
    }

    public func lockScreenSwipeReportingRoute(
        startX: Double, startY: Double, endX: Double, endY: Double, duration: TimeInterval
    )
        throws -> SwipeDispatchReport?
    {
        try lockScreenSwipe(startX: startX, startY: startY, endX: endX, endY: endY, duration: duration)
        return nil
    }

    public func path(points _: [PathGesturePoint]) throws {
        throw CommandError.invalidParameter("path", "unsupported by this gesture performer")
    }

    public func doubleTap(x _: Double, y _: Double) throws {
        throw CommandError.invalidParameter("doubleTap", "unsupported by this gesture performer")
    }

    public func tap(x: Double, y: Double, duration: TimeInterval, strategy _: String?) throws {
        try tap(x: x, y: y, duration: duration)
    }

    public func tapWithDiagnostics(
        x: Double,
        y: Double,
        durationMs: Int,
        strategy _: String?
    )
        throws -> TapDiagnostics
    {
        try tapWithDiagnostics(x: x, y: y, durationMs: durationMs)
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

/// The dispatch route a single-finger swipe really took (#13145). The raw values are the wire
/// strings of `WebSocketResponse.swipeRoute`.
public enum SwipeRoute: String, Equatable, Sendable {
    /// `XCUICoordinate` press-drag; velocity is clamped to 100-10000 pt/s.
    case xcuiCoordinate
    /// Private event synthesis for an app the runner did not launch; floors the stroke at 50 ms.
    case unpinnedSynthesized
    /// Private event synthesis for the lock screen (`lockScreen: true`).
    case lockScreenSynthesized
    /// Display-targeted private event synthesis (inner panel of a foldable); honors the duration.
    case displayTargetedSynthesized
}

/// Route plus the stroke duration that route really dispatched, so hosts can derive velocity and
/// clamp warnings from the route that ran rather than the one they assume.
public struct SwipeDispatchReport: Equatable, Sendable {
    public let route: SwipeRoute
    public let effectiveDurationMs: Int64

    /// Smallest contact the synthesis helper dispatches.
    static let synthesizedMinimumDuration: TimeInterval = 0.05

    private static func milliseconds(_ seconds: TimeInterval) -> Int64 {
        guard seconds.isFinite, seconds > 0 else { return 0 }
        return Int64((seconds * 1000).rounded())
    }

    /// The `XCUICoordinate` stroke runs `distance / velocity` where velocity is clamped.
    static func xcuiCoordinate(distance: Double, duration: TimeInterval) -> SwipeDispatchReport {
        let seconds = GesturePerformer.swipeVelocity(distance: distance, duration: duration)
            .map { distance / $0 } ?? duration
        return SwipeDispatchReport(route: .xcuiCoordinate, effectiveDurationMs: milliseconds(seconds))
    }

    static func unpinnedSynthesized(duration: TimeInterval) -> SwipeDispatchReport {
        SwipeDispatchReport(
            route: .unpinnedSynthesized,
            effectiveDurationMs: milliseconds(max(duration, synthesizedMinimumDuration))
        )
    }

    /// The report for the route a `DisplayGestureFactory` delivery really took (#13319).
    static func forDelivery(
        route: TapDiagnostics.Route, distance: Double, duration: TimeInterval
    )
        -> SwipeDispatchReport
    {
        switch route {
        case .xcuiCoordinate:
            return xcuiCoordinate(distance: distance, duration: duration)
        case .displayTargetedRecord:
            // The touch's move phase is the requested duration; no velocity clamp applies.
            return SwipeDispatchReport(route: .displayTargetedSynthesized, effectiveDurationMs: milliseconds(duration))
        }
    }

    static func lockScreenSynthesized(duration: TimeInterval) -> SwipeDispatchReport {
        SwipeDispatchReport(route: .lockScreenSynthesized, effectiveDurationMs: milliseconds(duration))
    }
}
