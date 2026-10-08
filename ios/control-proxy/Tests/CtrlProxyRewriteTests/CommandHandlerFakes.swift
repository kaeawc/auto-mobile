@testable import CtrlProxyRewrite
import Foundation

// Minimal `@MainActor` fakes for driving the rewrite `CommandHandler` through its routing
// without a live XCUITest. They mirror the reference `Fakes.swift` doubles closely enough
// that the response envelopes are byte-identical after stripping the volatile fields
// (timestamp / totalTimeMs / perfTiming / frameContext / updatedAt).

@MainActor
final class RewriteFakeElementLocator: ElementLocating, HierarchyExtracting {
    var foregroundBundleId: String?
    var appState: ObservedAppState = .notRunning
    private(set) var filteringRequests: [Bool] = []
    var hierarchy: ViewHierarchy
    var onCapture: (() throws -> Void)?

    init(hierarchy: ViewHierarchy = RewriteFakeElementLocator.defaultHierarchy) {
        self.hierarchy = hierarchy
    }

    static var defaultHierarchy: ViewHierarchy {
        ViewHierarchy(
            updatedAt: 1,
            packageName: "com.test.app",
            hierarchy: UIElementInfo(
                text: "Fake Root",
                className: "UIView",
                bounds: ElementBounds(left: 0, top: 0, right: 375, bottom: 812)
            ),
            windowInfo: WindowInfo(id: 0, type: 1, isActive: true, isFocused: true)
        )
    }

    func getViewHierarchy(disableAllFiltering: Bool) throws -> ViewHierarchy {
        filteringRequests.append(disableAllFiltering)
        try onCapture?()
        return hierarchy
    }

    func findElement(byResourceId _: String) -> Any? { nil }
    func findElement(byText _: String) -> Any? { nil }
    func findElement(byText _: String, bounds _: ElementBounds) -> Any? { nil }
    func trackObservedBundleId(_: String) {}
    func switchForegroundApp(bundleId: String) { foregroundBundleId = bundleId }
    func getAppState(bundleId _: String) -> ObservedAppState { appState }
    func awaitAppState(bundleId _: String, expectedState _: AppStateExpectation) -> Bool { true }
    func refreshForegroundBundleId() -> String? { foregroundBundleId }
}

@MainActor
final class RewriteFakeHierarchyDebouncer: HierarchyDebouncing {
    var cachedHierarchy: ViewHierarchy?
    private(set) var recordedCaptures: [ViewHierarchy] = []
    private(set) var pollIntervals: [Int64] = []
    private var captureSequence: UInt64 = 0

    func getLastHierarchy() -> ViewHierarchy? { cachedHierarchy }

    func beginCapture() -> UInt64 {
        captureSequence += 1
        return captureSequence
    }

    func recordCommandCapture(_ hierarchy: ViewHierarchy, captureSequence _: UInt64) {
        recordedCaptures.append(hierarchy)
        cachedHierarchy = hierarchy
    }

    func updatePollIntervalMs(_ pollIntervalMs: Int64) {
        pollIntervals.append(pollIntervalMs)
    }
}

@MainActor
final class RewriteFakeGesturePerformer: GesturePerforming {
    struct ActionCall {
        let action: String
        let resourceId: String?
        let label: String?
        let bounds: ElementBounds?
        let duration: Int?
    }

    private var orientation = "portrait"
    private var keyboardOpen = false
    var keyCalls: [(String, [String])] = []
    var keyError: CommandError?
    var tapCalls = 0
    var tapDurations: [TimeInterval] = []
    var lastTap: (x: Double, y: Double)?
    var diagnosticTapCalls = 0
    var tapStrategies: [String?] = []
    var tapDiagnosticsResult: TapDiagnostics?
    var lockScreenSwipeCalls = 0
    var swipeCalls = 0
    var onSwipe: (() -> Void)?
    var onPressKey: (() -> Void)?
    var multiFingerSwipeCalls = 0
    var pinchCalls = 0
    var setTextCalls = 0
    var clearTextCalls = 0
    var selectAllCalls = 0
    var imeActionCalls = 0
    var shakeCalls = 0
    var actionCalls = 0
    var lastAction: ActionCall?
    var activateAccessibilityLinkCalls = 0
    var setOrientationCalls = 0
    var onPressHome: (() -> Void)?
    var pressHomeError: CommandError?
    var rotationSupported = true
    var sameAxisRotationSupported = true
    var orientationUpdateDelayReads = 0
    private var pendingOrientation: String?
    private var remainingOrientationDelayReads = 0
    private var displayLandscape = false

    var keyVerified: Bool?
    var keyWarning: String?

    func pressKey(key: String, modifiers: [String]) async throws -> Bool? {
        onPressKey?()
        if let keyError { throw keyError }
        keyCalls.append((key, modifiers))
        return keyVerified
    }

    func pressKeyOutcome(key: String, modifiers: [String]) async throws -> PressKeyOutcome {
        try await PressKeyOutcome(verified: pressKey(key: key, modifiers: modifiers), warning: keyWarning)
    }

    func tap(x: Double, y: Double, duration: TimeInterval) throws {
        tapDurations.append(duration)
        tapCalls += 1
        lastTap = (x, y)
    }

    func tap(x: Double, y: Double, duration: TimeInterval, strategy: String?) throws {
        tapStrategies.append(strategy)
        try tap(x: x, y: y, duration: duration)
    }

    func tapWithDiagnostics(x: Double, y: Double, durationMs: Int, strategy: String?) throws -> TapDiagnostics {
        tapStrategies.append(strategy)
        return try tapWithDiagnostics(x: x, y: y, durationMs: durationMs)
    }

    func tapWithDiagnostics(x: Double, y: Double, durationMs: Int) throws -> TapDiagnostics {
        diagnosticTapCalls += 1
        return tapDiagnosticsResult ?? TapDiagnostics(requested: .init(x: x, y: y, durationMs: durationMs))
    }

    func swipe(startX _: Double, startY _: Double, endX _: Double, endY _: Double, duration _: TimeInterval) throws {
        swipeCalls += 1
        onSwipe?()
    }

    func lockScreenSwipe(
        startX _: Double, startY _: Double, endX _: Double, endY _: Double, duration _: TimeInterval
    )
        throws
    {
        lockScreenSwipeCalls += 1
        onSwipe?()
    }

    func multiFingerSwipe(
        startX _: Double, startY _: Double, endX _: Double, endY _: Double,
        fingerCount _: Int, fingerSpacing _: Double, duration _: TimeInterval
    )
        throws { multiFingerSwipeCalls += 1 }
    func drag(
        startX _: Double, startY _: Double, endX _: Double, endY _: Double,
        pressDuration _: TimeInterval, dragDuration _: TimeInterval, holdDuration _: TimeInterval
    )
        throws {}
    func pinch(
        centerX _: Double, centerY _: Double, distanceStart _: Double, distanceEnd _: Double,
        rotationDegrees _: Double, duration _: TimeInterval
    )
        throws -> PinchGesturePath
    {
        pinchCalls += 1
        return .eventPath
    }

    func typeText(text _: String) throws {}
    func appendText(text _: String) throws {}
    func setText(resourceId _: String, text _: String) async throws { setTextCalls += 1 }
    func clearText(resourceId _: String?) async throws { clearTextCalls += 1 }
    func selectAll() throws { selectAllCalls += 1 }
    func performImeAction(_: String) throws { imeActionCalls += 1 }
    func keyboard(action: String) async throws -> KeyboardActionResult {
        switch action {
        case "open": keyboardOpen = true
        case "close": keyboardOpen = false
        default: break
        }
        return KeyboardActionResult(open: keyboardOpen)
    }

    func clipboard(action _: String, text _: String?) throws -> String? { nil }
    func performAction(
        _ action: String,
        resourceId: String?,
        label: String?,
        bounds: ElementBounds?,
        duration: Int?
    )
        throws
    {
        actionCalls += 1
        lastAction = ActionCall(
            action: action, resourceId: resourceId, label: label, bounds: bounds, duration: duration
        )
    }

    func activateAccessibilityLink(text _: String, occurrence _: Int, ownerResourceId _: String?) throws {
        activateAccessibilityLinkCalls += 1
    }

    func getScreenshot() throws -> Data {
        var bytes = [UInt8](repeating: 0, count: 24)
        bytes.replaceSubrange(0 ..< 8, with: [137, 80, 78, 71, 13, 10, 26, 10])
        let width: UInt32 = displayLandscape ? 812 : 375
        let height: UInt32 = displayLandscape ? 375 : 812
        bytes.replaceSubrange(16 ..< 20, with: withUnsafeBytes(of: width.bigEndian) { Array($0) })
        bytes.replaceSubrange(20 ..< 24, with: withUnsafeBytes(of: height.bigEndian) { Array($0) })
        return Data(bytes)
    }

    func setOrientation(_ orientation: String) throws {
        setOrientationCalls += 1
        if !sameAxisRotationSupported &&
            self.orientation.hasPrefix("landscape") == orientation.hasPrefix("landscape")
        {
            return
        }
        if orientationUpdateDelayReads > 0 {
            pendingOrientation = orientation
            remainingOrientationDelayReads = orientationUpdateDelayReads
        } else {
            self.orientation = orientation
            if rotationSupported { displayLandscape = orientation.hasPrefix("landscape") }
        }
    }

    func getOrientation() -> String {
        if let pendingOrientation {
            if remainingOrientationDelayReads > 0 {
                remainingOrientationDelayReads -= 1
            } else {
                orientation = pendingOrientation
                self.pendingOrientation = nil
                if rotationSupported { displayLandscape = orientation.hasPrefix("landscape") }
            }
        }
        return orientation
    }

    func pressHome() throws {
        if let pressHomeError { throw pressHomeError }
        onPressHome?()
    }

    func pressBack() throws {}
    func shake() throws { shakeCalls += 1 }
    func pressButton(_: String) throws {}
    func openRecentApps() throws -> Bool { true }
    func launchApp(bundleId _: String) throws {}
    func terminateApp(bundleId _: String) throws {}
    func activateApp(bundleId _: String) throws {}
    func updateApplication(bundleId _: String) {}
    func resetAuthorizations(bundleId _: String, resources _: [String]) throws {}
}

@MainActor
final class FakeTapDiagnosticsSampler: TapDiagnosticsSampling {
    let result: TapDiagnostics
    var requests: [TapDiagnostics.Requested] = []

    init(result: TapDiagnostics) { self.result = result }

    func sample(requested: TapDiagnostics.Requested, reads _: TapDiagnosticReads) -> TapDiagnostics {
        requests.append(requested)
        return result
    }
}

@MainActor
final class FakeDisplayGestureProvider: DisplayGestureProviding {
    var cachedGeometry: GestureCoordinateGeometry?
    var inventory = GestureDisplayInventory(screens: [], applicationDisplayId: nil, isPhoneIdiom: true)
    var inventoryReads = 0
    var geometryReads = 0
    var touches: [DisplayTouch] = []
    var selections: [GestureCoordinateSelection] = []
    var actions: [String] = []
    var symbolsAvailable = true
    var synthesisError: Error?
    var tapDurations: [TimeInterval] = []

    init(geometry: GestureCoordinateGeometry?) { cachedGeometry = geometry }

    func geometry() throws -> GestureCoordinateGeometry? {
        geometryReads += 1
        return cachedGeometry
    }

    func displayInventory() -> GestureDisplayInventory {
        inventoryReads += 1
        return inventory
    }

    func synthesize(_ touch: DisplayTouch) throws -> Bool {
        touches.append(touch)
        if let synthesisError { throw synthesisError }
        return symbolsAvailable
    }

    func coordinate(selection: GestureCoordinateSelection) throws -> GestureCoordinateSelection {
        selections.append(selection)
        return selection
    }

    func tap(_: GestureCoordinateSelection, duration: TimeInterval) throws {
        tapDurations.append(duration)
        actions.append(duration > 0 ? "tapPress" : "tap")
    }

    func drag(
        _: GestureCoordinateSelection, to _: GestureCoordinateSelection,
        press _: TimeInterval, velocity _: Double?, hold _: TimeInterval
    )
        throws
    {
        actions.append("drag")
    }
}
