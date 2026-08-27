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

    func getViewHierarchy(disableAllFiltering: Bool) throws -> ViewHierarchy { hierarchy }
    func findElement(byResourceId resourceId: String) -> Any? { nil }
    func findElement(byText text: String) -> Any? { nil }
    func trackObservedBundleId(_ bundleId: String) {}
    func switchForegroundApp(bundleId: String) { foregroundBundleId = bundleId }
    func getAppState(bundleId: String) -> ObservedAppState { .notRunning }
    func awaitAppState(bundleId: String, expectedState: AppStateExpectation) -> Bool { true }
}

@MainActor
final class RewriteFakeGesturePerformer: GesturePerforming {
    private var orientation = "portrait"
    private var keyboardOpen = false

    func tap(x: Double, y: Double, duration: TimeInterval) throws {}
    func doubleTap(x: Double, y: Double) throws {}
    func longPress(x: Double, y: Double, duration: TimeInterval) throws {}
    func swipe(startX: Double, startY: Double, endX: Double, endY: Double, duration: TimeInterval) throws {}
    func multiFingerSwipe(
        startX: Double, startY: Double, endX: Double, endY: Double,
        fingerCount: Int, fingerSpacing: Double, duration: TimeInterval
    ) throws {}
    func drag(
        startX: Double, startY: Double, endX: Double, endY: Double,
        pressDuration: TimeInterval, dragDuration: TimeInterval, holdDuration: TimeInterval
    ) throws {}
    func pinch(
        centerX: Double, centerY: Double, distanceStart: Double, distanceEnd: Double,
        rotationDegrees: Double, duration: TimeInterval
    ) throws -> PinchGesturePath { .eventPath }
    func typeText(text: String) throws {}
    func appendText(text: String) throws {}
    func setText(resourceId: String, text: String) throws {}
    func clearText(resourceId: String?) throws {}
    func selectAll() throws {}
    func performImeAction(_ action: String) throws {}
    func keyboard(action: String) throws -> Bool {
        switch action {
        case "open": keyboardOpen = true
        case "close": keyboardOpen = false
        default: break
        }
        return keyboardOpen
    }
    func clipboard(action: String, text: String?) throws -> String? { nil }
    func performAction(_ action: String, resourceId: String?, label: String?) throws {}
    func activateAccessibilityLink(text: String, occurrence: Int, ownerResourceId: String?) throws {}
    func getScreenshot() throws -> Data { Data() }
    func setOrientation(_ orientation: String) throws { self.orientation = orientation }
    func getOrientation() -> String { orientation }
    func pressHome() throws {}
    func pressBack() throws {}
    func shake() throws {}
    func pressButton(_ button: String) throws {}
    func openRecentApps() throws -> Bool { true }
    func launchApp(bundleId: String) throws {}
    func terminateApp(bundleId: String) throws {}
    func activateApp(bundleId: String) throws {}
    func updateApplication(bundleId: String) {}
    func resetAuthorizations(bundleId: String, resources: [String]) throws {}
}

/// Drives the `CtrlProxyRewrite` `CommandHandler` (and the server, for the perfTiming
/// integration check). Imports only `CtrlProxyRewrite`; the parity test imports neither
/// module and diffs the two drivers' module-agnostic output.
enum RewriteCommandDriver {
    private static func sortedEncoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        return encoder
    }

    /// Route one request through a fresh `CommandHandler` and return the encoded response.
    @MainActor
    static func handleEncoded(_ json: String) async -> Data {
        guard let request = try? JSONDecoder().decode(WebSocketRequest.self, from: Data(json.utf8)) else {
            return Data()
        }
        let handler = CommandHandler(
            elementLocator: RewriteFakeElementLocator(),
            gesturePerformer: RewriteFakeGesturePerformer(),
            perf: PerfProvider()
        )
        let response = await handler.handle(request)
        return (try? sortedEncoder().encode(response)) ?? Data()
    }

    /// Drive one request through the real `WebSocketServer.handleMessage` (which brackets the
    /// command in `perf.withScope`) and return the response `perfTiming`'s canonical
    /// name-tree — the integration check that proves the `withScope` wiring emits timings on
    /// the wire. Returns a `Sendable` `String` (durations are wall-clock and stripped) so it
    /// can cross back from the main actor.
    @MainActor
    static func perfTimingTreeThroughServer(_ json: String) async -> String? {
        let perf = PerfProvider()
        let handler = CommandHandler(
            elementLocator: RewriteFakeElementLocator(),
            gesturePerformer: RewriteFakeGesturePerformer(),
            perf: perf
        )
        let server = WebSocketServer(port: 0, commandHandler: handler, perf: perf, frameContext: FrameContext())
        let responder = CapturingResponder()
        await server.handleMessage(Data(json.utf8), responder: responder)
        guard let data = responder.captured.first,
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        else {
            return nil
        }
        return PerfTimingTree.name(object["perfTiming"] as? [String: Any])
    }
}

/// Canonical `perfTiming` name-tree (durations stripped — they are wall-clock). Shared by
/// both drivers so the parity comparison is over `Sendable` `String`s.
enum PerfTimingTree {
    static func name(_ node: [String: Any]?) -> String? {
        guard let node, let nodeName = node["name"] as? String else { return nil }
        let children = (node["children"] as? [[String: Any]]) ?? []
        guard !children.isEmpty else { return nodeName }
        return nodeName + "[" + children.compactMap { Self.name($0) }.joined(separator: ",") + "]"
    }
}
