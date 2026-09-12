@testable import CtrlProxyRewrite
import Foundation

// Minimal `@MainActor` fakes for driving the rewrite `CommandHandler` through its routing
// without a live XCUITest. They mirror the reference `Fakes.swift` doubles closely enough
// that the response envelopes are byte-identical after stripping the volatile fields
// (timestamp / totalTimeMs / perfTiming / frameContext / updatedAt).

@MainActor
final class RewriteFakeElementLocator: ElementLocating {
    var foregroundBundleId: String?
    private let hierarchy: ViewHierarchy

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

    func getViewHierarchy(disableAllFiltering _: Bool) throws -> ViewHierarchy { hierarchy }
    func findElement(byResourceId _: String) -> Any? { nil }
    func findElement(byText _: String) -> Any? { nil }
    func trackObservedBundleId(_: String) {}
    func switchForegroundApp(bundleId: String) { foregroundBundleId = bundleId }
    func getAppState(bundleId _: String) -> ObservedAppState { .notRunning }
    func awaitAppState(bundleId _: String, expectedState _: AppStateExpectation) -> Bool { true }
}

@MainActor
final class RewriteFakeGesturePerformer: GesturePerforming {
    private var orientation = "portrait"
    private var keyboardOpen = false
    var keyCalls: [(String, [String])] = []
    var keyError: CommandError?

    func pressKey(key: String, modifiers: [String]) throws {
        if let keyError { throw keyError }
        keyCalls.append((key, modifiers))
    }

    func tap(x _: Double, y _: Double, duration _: TimeInterval) throws {}
    func doubleTap(x _: Double, y _: Double) throws {}
    func longPress(x _: Double, y _: Double, duration _: TimeInterval) throws {}
    func swipe(startX _: Double, startY _: Double, endX _: Double, endY _: Double, duration _: TimeInterval) throws {}
    func multiFingerSwipe(
        startX _: Double, startY _: Double, endX _: Double, endY _: Double,
        fingerCount _: Int, fingerSpacing _: Double, duration _: TimeInterval
    )
        throws {}
    func drag(
        startX _: Double, startY _: Double, endX _: Double, endY _: Double,
        pressDuration _: TimeInterval, dragDuration _: TimeInterval, holdDuration _: TimeInterval
    )
        throws {}
    func pinch(
        centerX _: Double, centerY _: Double, distanceStart _: Double, distanceEnd _: Double,
        rotationDegrees _: Double, duration _: TimeInterval
    )
        throws -> PinchGesturePath { .eventPath }
    func typeText(text _: String) throws {}
    func appendText(text _: String) throws {}
    func setText(resourceId _: String, text _: String) throws {}
    func clearText(resourceId _: String?) throws {}
    func selectAll() throws {}
    func performImeAction(_: String) throws {}
    func keyboard(action: String) throws -> Bool {
        switch action {
        case "open": keyboardOpen = true
        case "close": keyboardOpen = false
        default: break
        }
        return keyboardOpen
    }

    func clipboard(action _: String, text _: String?) throws -> String? { nil }
    func performAction(_: String, resourceId _: String?, label _: String?) throws {}
    func activateAccessibilityLink(text _: String, occurrence _: Int, ownerResourceId _: String?) throws {}
    func getScreenshot() throws -> Data { Data() }
    func setOrientation(_ orientation: String) throws { self.orientation = orientation }
    func getOrientation() -> String { orientation }
    func pressHome() throws {}
    func pressBack() throws {}
    func shake() throws {}
    func pressButton(_: String) throws {}
    func openRecentApps() throws -> Bool { true }
    func launchApp(bundleId _: String) throws {}
    func terminateApp(bundleId _: String) throws {}
    func activateApp(bundleId _: String) throws {}
    func updateApplication(bundleId _: String) {}
    func resetAuthorizations(bundleId _: String, resources _: [String]) throws {}
}
