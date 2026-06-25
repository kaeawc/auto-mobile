import Foundation
#if canImport(os)
import os
#endif
#if canImport(XCTest) && os(iOS)
    import XCTest
#endif

/// Logger for text-input focus diagnostics.
/// See `Logging.swift` for the log-level contract shared across CtrlProxy.
private let gestureLog = Logger(subsystem: ctrlProxyLogSubsystem, category: "GesturePerformer")

/// Performs gestures and interactions using XCUITest APIs
public class GesturePerformer: GesturePerforming {
    public enum GestureError: LocalizedError {
        case noApplication
        case elementNotFound(String)
        case gestureFailed(String)
        case notSupported(String)
        case missingParameter(String)
        case clipboardEmpty
        case unsupportedAction(String)

        public var errorDescription: String? {
            switch self {
            case .noApplication:
                return "No application available for gestures"
            case let .elementNotFound(id):
                return "Element not found: \(id)"
            case let .gestureFailed(reason):
                return "Gesture failed: \(reason)"
            case let .notSupported(feature):
                return "Feature not supported: \(feature)"
            case let .missingParameter(param):
                return "Missing parameter: \(param)"
            case .clipboardEmpty:
                return "Clipboard is empty"
            case let .unsupportedAction(action):
                return "Unsupported action: \(action)"
            }
        }
    }

    #if canImport(XCTest) && os(iOS)
        private weak var application: XCUIApplication?
        /// Strong reference to keep the application alive when set via updateApplication.
        /// Without this, the weak `application` property would immediately deallocate
        /// freshly created XCUIApplication instances that have no other strong owner.
        private var ownedApplication: XCUIApplication?
        private let elementLocator: ElementLocating

        /// Cached SpringBoard app reference for system alert handling.
        private lazy var springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")

        public init(application: XCUIApplication? = nil, elementLocator: ElementLocating) {
            self.application = application
            self.elementLocator = elementLocator
        }

        // MARK: - Keyboard Focus Helpers

        /// Returns true if any text-input element in the snapshot has UIKit
        /// first-responder focus (`snapshot.hasFocus`).
        ///
        /// Used as a fallback when the `hasKeyboardFocus == true` NSPredicate
        /// returns no results — which happens with React Native `TextInput`
        /// fields and other frameworks whose UITextField wrapper is the UIKit
        /// first responder but does not propagate `hasKeyboardFocus` through
        /// the XCTest accessibility bridge. `snapshot.hasFocus` reliably
        /// reflects UIKit first-responder state, mirroring what
        /// `ElementLocator` uses to populate `focused: true` in the hierarchy.
        ///
        /// For `.other` (RN wrapper views), require a non-empty `value` or
        /// `placeholderValue` before treating the node as a text input —
        /// otherwise any focused `.other` (a button, custom control, etc.)
        /// would register as focused text and we'd try to delete from it.
        ///
        /// Depth-guarded at 64 to bound recursion on pathological trees.
        private static func snapshotHasTextInputWithFocus(
            _ snapshot: XCUIElementSnapshot,
            depth: Int = 0
        ) -> Bool {
            if depth > 64 { return false }

            let type = snapshot.elementType
            let isKnownTextInput = type == .textField
                || type == .textView
                || type == .secureTextField
            let isTextLikeOther = type == .other && snapshotLooksLikeTextInput(snapshot)

            if (isKnownTextInput || isTextLikeOther) && snapshot.hasFocus {
                return true
            }
            for child in snapshot.children {
                if snapshotHasTextInputWithFocus(child, depth: depth + 1) { return true }
            }
            return false
        }

        /// Heuristic for treating an `.other`-typed snapshot as a text-input
        /// wrapper. Text fields expose a non-empty `value` (current content)
        /// or a `placeholderValue` (hint text); plain buttons / containers
        /// do not.
        private static func snapshotLooksLikeTextInput(_ snapshot: XCUIElementSnapshot) -> Bool {
            if let value = snapshot.value as? String, !value.isEmpty {
                return true
            }
            if let placeholder = snapshot.placeholderValue, !placeholder.isEmpty {
                return true
            }
            return false
        }

        /// Detection strategies for keyboard focus, in order of cost:
        ///
        /// 1. `hasKeyboardFocus == true` NSPredicate — cheap, reliable for
        ///    standard UIKit apps.
        /// 2. Snapshot `hasFocus` traversal — catches React Native TextInputs
        ///    and other frameworks whose first-responder status isn't
        ///    exposed through `hasKeyboardFocus`.
        /// 3. Keyboard-visibility probe — last-resort safety net; if the
        ///    system keyboard is visible, something in the user-visible app
        ///    must own first responder.
        ///
        /// Returns `(hasFocus, strategy)` so the caller can log which path
        /// won. Query runs on the main thread.
        private func detectKeyboardFocus(app: XCUIApplication) throws -> (Bool, String) {
            return try runOnMainThread { [springboard] in
                // Strategy 1: predicate
                let byPredicate = app.descendants(matching: .any)
                    .matching(NSPredicate(format: "hasKeyboardFocus == true"))
                    .firstMatch
                    .exists
                if byPredicate {
                    return (true, "predicate")
                }

                // Strategy 2: snapshot.hasFocus traversal. Skip SpringBoard —
                // the app we want is never SpringBoard in a text-input flow.
                if app.identifier != "com.apple.springboard" {
                    if let snapshot = try? app.snapshot(),
                       GesturePerformer.snapshotHasTextInputWithFocus(snapshot) {
                        return (true, "snapshot.hasFocus")
                    }
                }

                // Strategy 3: keyboard-visibility probe. Covers the case
                // where neither the predicate nor the snapshot picks up
                // focus (e.g., unknown/stale foreground bundle ID) but the
                // user-visible keyboard proves something owns first responder.
                if springboard.keyboards.firstMatch.exists || app.keyboards.firstMatch.exists {
                    return (true, "keyboard-visibility")
                }

                return (false, "none")
            }
        }

        /// Check that some element in the app has keyboard focus.
        /// Throws with a contextual error message if no focus is detected.
        /// On failure, the thrown error embeds a focus-diagnostic summary so
        /// it surfaces in the MCP response — not just in device logs.
        private func requireKeyboardFocus(app: XCUIApplication, context: String) throws {
            let queryStart = Date()
            let (hasFocus, strategy) = try detectKeyboardFocus(app: app)
            let elapsedMs = Int(Date().timeIntervalSince(queryStart) * 1000)
            let appLabel = runOnMainThreadNonThrowing({ app.label }, fallback: "unknown")
            gestureLog.debug("requireKeyboardFocus hasFocus=\(hasFocus, privacy: .public) strategy=\(strategy, privacy: .public) context=\"\(context, privacy: .public)\" elapsedMs=\(elapsedMs, privacy: .public) appLabel=\(appLabel, privacy: .public)")

            guard hasFocus else {
                let diag = buildFocusDiagnostic(app: app, reason: "requireKeyboardFocus: \(context)")
                gestureLog.error("\(diag, privacy: .public)")
                throw GestureError.gestureFailed(
                    "No element has keyboard focus — \(context). Diagnostic: \(diag)"
                )
            }
        }

        /// Tap an element and poll for keyboard focus (500ms timeout, 50ms
        /// intervals). Uses the same 3-strategy detection as
        /// `requireKeyboardFocus`. Timeout was extended from 200ms → 500ms
        /// to accommodate the snapshot-based fallback, which does an extra
        /// XPC round-trip per poll when the predicate misses.
        ///
        /// Throws if the element does not receive focus after the tap.
        private func tapAndAwaitKeyboardFocus(
            app: XCUIApplication,
            element: XCUIElement,
            resourceId: String
        ) throws {
            let tapStart = Date()
            gestureLog.debug("tapAndAwaitKeyboardFocus begin resourceId=\(resourceId, privacy: .public) exists=\(element.exists, privacy: .public) isHittable=\(element.isHittable, privacy: .public) type=\(element.elementType.rawValue, privacy: .public)")
            element.tap()

            let deadline = Date().addingTimeInterval(0.5)
            var hasFocus = false
            var strategy = "none"
            var iterations = 0
            while !hasFocus && Date() < deadline {
                let result = try detectKeyboardFocus(app: app)
                hasFocus = result.0
                strategy = result.1
                iterations += 1
                if !hasFocus {
                    RunLoop.current.run(until: Date().addingTimeInterval(0.05))
                }
            }
            let elapsedMs = Int(Date().timeIntervalSince(tapStart) * 1000)
            gestureLog.debug("tapAndAwaitKeyboardFocus done resourceId=\(resourceId, privacy: .public) hasFocus=\(hasFocus, privacy: .public) strategy=\(strategy, privacy: .public) iterations=\(iterations, privacy: .public) elapsedMs=\(elapsedMs, privacy: .public)")

            guard hasFocus else {
                let diag = buildFocusDiagnostic(app: app, reason: "tapAndAwaitKeyboardFocus: \(resourceId)")
                gestureLog.error("\(diag, privacy: .public)")
                throw GestureError.gestureFailed(
                    "Element '\(resourceId)' did not receive keyboard focus after tap. Diagnostic: \(diag)"
                )
            }
        }

        /// Build a compact diagnostic string enumerating candidate text-entry
        /// elements and their focus state, for #1925-style "no keyboard focus"
        /// failures. Returned as a single line so it fits in a WebSocket error.
        private func buildFocusDiagnostic(app: XCUIApplication, reason: String) -> String {
            return runOnMainThreadNonThrowing({ [springboard] in
                var parts: [String] = []
                parts.append("reason=\"\(reason)\"")
                parts.append("app.label=\"\(app.label)\"")
                parts.append("app.identifier=\"\(app.identifier)\"")

                let typesToProbe: [(String, XCUIElement.ElementType)] = [
                    ("textFields", .textField),
                    ("secureTextFields", .secureTextField),
                    ("textViews", .textView),
                    ("searchFields", .searchField),
                ]

                for (name, type) in typesToProbe {
                    let query = app.descendants(matching: type)
                    let count = query.count
                    parts.append("\(name).count=\(count)")

                    // Only introspect a small number to avoid heavy XPC.
                    let cap = min(count, 5)
                    if cap > 0 {
                        for i in 0..<cap {
                            let el = query.element(boundBy: i)
                            let hasFocus = (el.value(forKey: "hasKeyboardFocus") as? Bool) ?? false
                            let identifier = el.identifier
                            let value = (el.value as? String) ?? ""
                            let isSelected = el.isSelected
                            let isHittable = el.isHittable
                            let frame = el.frame
                            parts.append("\(name)[\(i)]={id=\"\(identifier)\",hasKeyboardFocus=\(hasFocus),isSelected=\(isSelected),isHittable=\(isHittable),value.len=\(value.count),frame=\(Int(frame.origin.x)),\(Int(frame.origin.y)),\(Int(frame.size.width)),\(Int(frame.size.height))}")
                        }
                    }
                }

                parts.append("app.keyboards.count=\(app.keyboards.count)")
                parts.append("springboard.keyboards.count=\(springboard.keyboards.count)")
                return parts.joined(separator: " | ")
            }, fallback: "reason=\"\(reason)\" [diagnostic collection failed]")
        }

        public func setApplication(_ app: XCUIApplication) {
            ownedApplication = nil
            application = app
        }

        // MARK: - Tap Gestures

        public func tap(x: Double, y: Double, duration: TimeInterval = 0) throws {
            guard let app = application else {
                throw GestureError.noApplication
            }

            try runOnMainThread {
                let coordinate = app.coordinate(withNormalizedOffset: .zero)
                    .withOffset(CGVector(dx: x, dy: y))

                if duration > 0 {
                    coordinate.press(forDuration: duration)
                } else {
                    coordinate.tap()
                }
            }
        }

        public func doubleTap(x: Double, y: Double) throws {
            guard let app = application else {
                throw GestureError.noApplication
            }

            try runOnMainThread {
                let coordinate = app.coordinate(withNormalizedOffset: .zero)
                    .withOffset(CGVector(dx: x, dy: y))
                coordinate.doubleTap()
            }
        }

        public func longPress(x: Double, y: Double, duration: TimeInterval) throws {
            guard let app = application else {
                throw GestureError.noApplication
            }

            try runOnMainThread {
                let coordinate = app.coordinate(withNormalizedOffset: .zero)
                    .withOffset(CGVector(dx: x, dy: y))
                coordinate.press(forDuration: duration)
            }
        }

        // MARK: - Swipe Gestures

        public func swipe(startX: Double, startY: Double, endX: Double, endY: Double, duration _: TimeInterval) throws {
            guard let app = application else {
                throw GestureError.noApplication
            }

            try runOnMainThread {
                let startCoordinate = app.coordinate(withNormalizedOffset: .zero)
                    .withOffset(CGVector(dx: startX, dy: startY))
                let endCoordinate = app.coordinate(withNormalizedOffset: .zero)
                    .withOffset(CGVector(dx: endX, dy: endY))

                startCoordinate.press(
                    forDuration: 0.05,
                    thenDragTo: endCoordinate,
                    withVelocity: .default,
                    thenHoldForDuration: 0
                )
            }
        }

        // MARK: - Drag Gestures

        public func drag(
            startX: Double, startY: Double,
            endX: Double, endY: Double,
            pressDuration: TimeInterval,
            dragDuration: TimeInterval,
            holdDuration: TimeInterval
        )
            throws
        {
            guard let app = application else {
                throw GestureError.noApplication
            }

            try runOnMainThread {
                let startCoordinate = app.coordinate(withNormalizedOffset: .zero)
                    .withOffset(CGVector(dx: startX, dy: startY))
                let endCoordinate = app.coordinate(withNormalizedOffset: .zero)
                    .withOffset(CGVector(dx: endX, dy: endY))

                // XCUICoordinate's drag API takes a velocity (points/second), not a duration,
                // so honor the caller's dragDuration by converting it into the velocity that
                // covers the source→target distance in that time. This gives iOS the same
                // drag-speed control Android has. Fall back to .default when the duration or
                // distance is non-positive (avoids divide-by-zero / infinite velocity).
                let distance = hypot(endX - startX, endY - startY)
                let velocity: XCUIGestureVelocity = (dragDuration > 0 && distance > 0)
                    ? XCUIGestureVelocity(distance / dragDuration)
                    : .default

                // Press, drag, and hold
                startCoordinate.press(
                    forDuration: pressDuration,
                    thenDragTo: endCoordinate,
                    withVelocity: velocity,
                    thenHoldForDuration: holdDuration
                )
            }
        }

        // MARK: - Pinch Gestures

        public func pinch(centerX _: Double, centerY _: Double, scale _: Double, duration _: TimeInterval) throws {
            // Pinch gesture using XCUITest is limited
            // We can simulate by using the app's pinch method if an element is available
            throw GestureError.notSupported("Coordinate-based pinch not yet implemented")
        }

        // MARK: - Text Input

        /// Resolve the XCUIApplication to use for text-input accessibility queries.
        ///
        /// Prefers the ElementLocator's tracked foreground bundle ID over the
        /// (possibly stale) self.application. See issue #1925: the MCP server
        /// launches apps via `simctl launch`, which updates ElementLocator's
        /// tracker (through the observe path) but does NOT reach CommandHandler's
        /// handleLaunchApp, so GesturePerformer.application stays pinned at
        /// whatever CtrlProxy.start() initialised it to (SpringBoard / the
        /// test host). That stale reference then returns zero textFields /
        /// zero keyboards, making every typeText fail with "No element has
        /// keyboard focus" — even when the app demonstrably has a focused
        /// text field and a visible keyboard.
        ///
        /// Coordinate-based gestures (tap/swipe/drag/pinch) deliberately use
        /// the SpringBoard anchor and do NOT go through this method.
        private func resolveTextInputApp() -> XCUIApplication? {
            if let bundleId = elementLocator.foregroundBundleId, !bundleId.isEmpty {
                return XCUIApplication(bundleIdentifier: bundleId)
            }
            return application
        }

        private func resolveNavigationApp() -> XCUIApplication? {
            if let bundleId = elementLocator.foregroundBundleId, !bundleId.isEmpty {
                return XCUIApplication(bundleIdentifier: bundleId)
            }
            return application
        }

        public func typeText(text: String) throws {
            guard let app = resolveTextInputApp() else {
                throw GestureError.noApplication
            }

            try requireKeyboardFocus(app: app, context: "ensure a text field is focused before typing")

            try runOnMainThread {
                app.typeText(text)
            }
        }

        public func setText(resourceId: String, text: String) throws {
            guard let app = resolveTextInputApp() else {
                throw GestureError.noApplication
            }
            guard let element = elementLocator.findElement(byResourceId: resourceId) as? XCUIElement else {
                throw GestureError.elementNotFound(resourceId)
            }

            try runOnMainThread {
                try self.tapAndAwaitKeyboardFocus(app: app, element: element, resourceId: resourceId)
                GesturePerformer.clearFocusedText(app: app, element: element)
                app.typeText(text)
            }
        }

        public func clearText(resourceId: String? = nil) throws {
            guard let app = resolveTextInputApp() else {
                throw GestureError.noApplication
            }

            if let resourceId = resourceId {
                guard let element = elementLocator.findElement(byResourceId: resourceId) as? XCUIElement else {
                    throw GestureError.elementNotFound(resourceId)
                }
                try runOnMainThread {
                    try self.tapAndAwaitKeyboardFocus(app: app, element: element, resourceId: resourceId)
                    GesturePerformer.clearFocusedText(app: app, element: element)
                }
            } else {
                try requireKeyboardFocus(app: app, context: "ensure a text field is focused before clearing")
                let focused = resolveFocusedTextElement(app: app)
                try runOnMainThread {
                    if let focused = focused {
                        GesturePerformer.clearFocusedText(app: app, element: focused)
                    } else {
                        app.typeKey("a", modifierFlags: .command)
                        app.typeText(XCUIKeyboardKey.delete.rawValue)
                    }
                }
            }
        }

        /// Resolve the focused text-input element so we can check its type.
        /// Returns nil if no element can be identified (caller falls back to
        /// Cmd+A+Delete which works for native inputs).
        private func resolveFocusedTextElement(app: XCUIApplication) -> XCUIElement? {
            return (try? runOnMainThread {
                let byPredicate = app.descendants(matching: .any)
                    .matching(NSPredicate(format: "hasKeyboardFocus == true"))
                    .firstMatch
                if byPredicate.exists {
                    return byPredicate
                }

                let queries: [XCUIElementQuery] = [
                    app.textFields,
                    app.secureTextFields,
                    app.textViews,
                    app.searchFields,
                ]
                for query in queries {
                    let count = query.count
                    guard count > 0 else { continue }
                    for i in 0..<count {
                        let candidate = query.element(boundBy: i)
                        guard let snap = try? candidate.snapshot() else { continue }
                        if snap.hasFocus { return candidate }
                    }
                }

                let otherQuery = app.otherElements
                let otherCount = otherQuery.count
                for i in 0..<otherCount {
                    let candidate = otherQuery.element(boundBy: i)
                    guard let snap = try? candidate.snapshot() else { continue }
                    if snap.hasFocus && GesturePerformer.snapshotLooksLikeTextInput(snap) {
                        return candidate
                    }
                }

                return nil
            }) ?? nil
        }

        /// Clear text from a focused element, choosing the strategy based on
        /// element type. Native UIKit inputs use Cmd+A + Delete (O(1)). React
        /// Native wrappers (`.other`) use per-character deletes so RN's
        /// onChangeText JS bridge fires for each keystroke.
        private static func clearFocusedText(app: XCUIApplication, element: XCUIElement) {
            let type = element.elementType
            let isNativeTextInput = type == .textField
                || type == .textView
                || type == .secureTextField
                || type == .searchField

            if isNativeTextInput {
                app.typeKey("a", modifierFlags: .command)
                app.typeText(XCUIKeyboardKey.delete.rawValue)
            } else {
                clearViaDeletes(element: element)
            }
        }

        private static let clearViaDeletesBurstSize = 50
        private static let clearViaDeletesMaxIterations = 20

        /// Per-character delete loop for React Native TextInputs. RN's
        /// onChangeText bridge requires individual delete keystrokes —
        /// Cmd+A+Delete clears only the native buffer while JS state stays stale.
        /// No value-based progress check: RN wrappers can report a stable
        /// accessibility identifier as `value` regardless of actual content,
        /// so the loop runs the full count. Extra deletes on an empty field
        /// are harmless no-ops.
        private static func clearViaDeletes(element: XCUIElement) {
            for _ in 0..<clearViaDeletesMaxIterations {
                let current = (element.value as? String) ?? ""
                if current.isEmpty { break }
                element.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
                element.typeText(String(
                    repeating: XCUIKeyboardKey.delete.rawValue,
                    count: clearViaDeletesBurstSize
                ))
            }
        }

        public func selectAll() throws {
            guard let app = resolveTextInputApp() else {
                throw GestureError.noApplication
            }

            try requireKeyboardFocus(app: app, context: "ensure a text field is focused before selecting")

            try runOnMainThread {
                app.typeKey("a", modifierFlags: .command)
            }
        }

        public func performImeAction(_ action: String) throws {
            guard let app = resolveTextInputApp() else {
                throw GestureError.noApplication
            }

            switch action.lowercased() {
            case "done", "go", "search", "send", "next":
                try runOnMainThread {
                    app.typeText("\n")
                }
            case "previous":
                try runOnMainThread {
                    app.typeKey(.tab, modifierFlags: .shift)
                }
            default:
                throw GestureError.notSupported("IME action: \(action)")
            }
        }

        public func keyboard(action: String) throws -> Bool {
            guard let app = resolveTextInputApp() else {
                throw GestureError.noApplication
            }

            switch action.lowercased() {
            case "detect":
                return isKeyboardVisible(app: app)
            case "open":
                if isKeyboardVisible(app: app) {
                    return true
                }
                guard let focused = resolveFocusedTextElement(app: app) else {
                    throw GestureError.notSupported("No focused text input to open keyboard")
                }
                try runOnMainThread {
                    focused.tap()
                }
                return waitForKeyboardVisibility(app: app, expected: true)
            case "close":
                if !isKeyboardVisible(app: app) {
                    return false
                }
                try typeKeyboardKey(.escape, app: app)
                return waitForKeyboardVisibility(app: app, expected: false)
            default:
                throw GestureError.notSupported("Keyboard action: \(action)")
            }
        }

        private func waitForKeyboardVisibility(
            app: XCUIApplication,
            expected: Bool,
            timeout: TimeInterval = 1.0,
            interval: TimeInterval = 0.05
        ) -> Bool {
            let deadline = Date().addingTimeInterval(timeout)
            var visible = isKeyboardVisible(app: app)
            while visible != expected && Date() < deadline {
                RunLoop.current.run(until: Date().addingTimeInterval(interval))
                visible = isKeyboardVisible(app: app)
            }
            return visible
        }

        private func isKeyboardVisible(app: XCUIApplication) -> Bool {
            return (try? runOnMainThread {
                app.keyboards.firstMatch.exists || self.springboard.keyboards.firstMatch.exists
            }) ?? false
        }

        private func typeKeyboardKey(_ key: XCUIKeyboardKey, app: XCUIApplication) throws {
            try runOnMainThread {
                app.typeKey(key, modifierFlags: [])
            }
        }

        // MARK: - Actions

        public func performAction(_ action: String, resourceId: String? = nil, label: String? = nil) throws {
            var element: XCUIElement? = nil
            if let resourceId = resourceId {
                element = elementLocator.findElement(byResourceId: resourceId) as? XCUIElement
            }
            if element == nil, let label = label {
                element = elementLocator.findElement(byText: label) as? XCUIElement
            }
            guard let found = element else {
                throw GestureError.elementNotFound(resourceId ?? label ?? "unknown")
            }

            try runOnMainThread {
                switch action.lowercased() {
                case "click", "tap":
                    found.tap()
                case "long_click", "long_press":
                    found.press(forDuration: 1.0)
                case "double_tap", "double_click":
                    found.doubleTap()
                case "scroll_forward":
                    found.swipeUp()
                case "scroll_backward":
                    found.swipeDown()
                case "focus":
                    found.tap()
                default:
                    throw GestureError.notSupported("Action: \(action)")
                }
            }
        }

        // MARK: - Screenshots

        public func getScreenshot() throws -> Data {
            guard let app = application else {
                throw GestureError.noApplication
            }

            return try runOnMainThread {
                let screenshot = app.screenshot()
                return screenshot.pngRepresentation
            }
        }

        // MARK: - Device Control

        public func setOrientation(_ orientation: String) throws {
            try runOnMainThread {
                let device = XCUIDevice.shared

                switch orientation.lowercased() {
                case "portrait":
                    device.orientation = .portrait
                case "portrait_upside_down", "portraitupsidedown":
                    device.orientation = .portraitUpsideDown
                case "landscape_left", "landscapeleft":
                    device.orientation = .landscapeLeft
                case "landscape_right", "landscaperight":
                    device.orientation = .landscapeRight
                default:
                    throw GestureError.gestureFailed("Unknown orientation: \(orientation)")
                }
            }
        }

        public func getOrientation() -> String {
            return runOnMainThreadNonThrowing({
                let device = XCUIDevice.shared

                switch device.orientation {
                case .portrait: return "portrait"
                case .portraitUpsideDown: return "portrait_upside_down"
                case .landscapeLeft: return "landscape_left"
                case .landscapeRight: return "landscape_right"
                default: return "unknown"
                }
            }, fallback: "unknown")
        }

        // MARK: - Clipboard

        /// Shadow of the most recent value this runner wrote via `copy` (or
        /// cleared via `clear`). Used as a fallback for `get` and `paste`
        /// when iOS's privacy-gated pasteboard read on a UI-test runner
        /// hangs on a `Paste from <app>` system alert that no user is
        /// available to dismiss. Without this, `runOnMainThread`'s
        /// `DispatchQueue.main.sync` blocks indefinitely.
        private static var clipboardShadow: String?
        private static let clipboardShadowQueue = DispatchQueue(label: "com.automobile.ctrlproxy.clipboard-shadow")

        private static func readShadow() -> String? {
            clipboardShadowQueue.sync { clipboardShadow }
        }

        private static func writeShadow(_ value: String?) {
            clipboardShadowQueue.sync { clipboardShadow = value }
        }

        /// Read `UIPasteboard.general.string` with a bounded timeout. The
        /// pasteboard read can deadlock the runner on iOS 16+ when a
        /// privacy alert is presented but no user is available to dismiss
        /// it. Returns nil on timeout instead of blocking forever.
        private static func readPasteboardWithTimeout(_ timeout: DispatchTimeInterval) -> String? {
            // Skip the read entirely if there are no strings — `hasStrings`
            // is a non-prompting synchronous check.
            guard UIPasteboard.general.hasStrings else { return nil }
            let semaphore = DispatchSemaphore(value: 0)
            let box = NSMutableArray() // Heap-allocated holder so the closure can write past return
            DispatchQueue.global(qos: .userInitiated).async {
                if let str = UIPasteboard.general.string {
                    box.add(str)
                }
                semaphore.signal()
            }
            if semaphore.wait(timeout: .now() + timeout) == .timedOut {
                return nil
            }
            return box.firstObject as? String
        }

        public func clipboard(action: String, text: String?) throws -> String? {
            switch action {
            case "get":
                let live = GesturePerformer.readPasteboardWithTimeout(.milliseconds(500))
                let shadow = GesturePerformer.readShadow()
                if let live = live, !live.isEmpty { return live }
                return shadow

            case "copy":
                guard let text = text else {
                    throw GestureError.missingParameter("text required for copy")
                }
                try runOnMainThread {
                    UIPasteboard.general.string = text
                }
                GesturePerformer.writeShadow(text)
                return nil

            case "clear":
                try runOnMainThread {
                    UIPasteboard.general.items = []
                }
                GesturePerformer.writeShadow(nil)
                return nil

            case "paste":
                // Use foreground-app resolution (#1925) — the clipboard paste
                // path also needs to query the correct app for hasKeyboardFocus.
                guard let app = resolveTextInputApp() else {
                    throw GestureError.noApplication
                }
                // Use bounded read; fall back to shadow if iOS gates the read.
                let pasteboardLive = GesturePerformer.readPasteboardWithTimeout(.milliseconds(500))
                let clipboardText = pasteboardLive ?? GesturePerformer.readShadow()
                guard let pasteText = clipboardText, !pasteText.isEmpty else {
                    throw GestureError.clipboardEmpty
                }
                _ = pasteText

                try requireKeyboardFocus(app: app, context: "ensure a text field is focused before pasting")

                // Use Cmd+V for real paste — handles emoji, Unicode, and is a single operation
                try runOnMainThread {
                    app.typeKey("v", modifierFlags: .command)
                }

                // iOS 16+ may show "Allow Paste" system alert (label is English-only;
                // no reliable cross-locale alternative exists without button index)
                try handlePasteAlert()
                return nil

            default:
                throw GestureError.unsupportedAction(action)
            }
        }

        /// Handle iOS 16+ "Allow Paste" system alert that appears when pasting
        /// content set by another process. Checks SpringBoard for the alert button
        /// and taps it if present. No-op on iOS 15 or if already permitted.
        private func handlePasteAlert() throws {
            try runOnMainThread {
                let allowButton = self.springboard.buttons["Allow Paste"]
                // Quick existence check avoids full 0.5s wait when no alert is present
                if allowButton.exists || allowButton.waitForExistence(timeout: 0.3) {
                    allowButton.tap()
                }
            }
        }

        public func pressHome() throws {
            try runOnMainThread {
                XCUIDevice.shared.press(.home)
            }
        }

        public func pressBack() throws {
            guard let app = resolveNavigationApp() else {
                throw GestureError.noApplication
            }

            try runOnMainThread {
                if self.tapExplicitNavigationBarBackButton(in: app) {
                    return
                }
                try self.swipeFromLeftEdge(in: app)
            }
        }

        private func tapExplicitNavigationBarBackButton(in app: XCUIApplication) -> Bool {
            for navigationBar in app.navigationBars.allElementsBoundByIndex where navigationBar.exists {
                let midpoint = navigationBar.frame.midX
                for button in navigationBar.buttons.allElementsBoundByIndex where button.exists && button.isHittable {
                    if button.frame.midX <= midpoint && self.isExplicitBackButton(button) {
                        button.tap()
                        return true
                    }
                }
            }
            return false
        }

        private func isExplicitBackButton(_ button: XCUIElement) -> Bool {
            let candidates = [button.label, button.identifier]
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
                .filter { !$0.isEmpty }
            return candidates.contains { value in
                value == "back" || value.contains("back button") || value.contains("go back")
            }
        }

        private func swipeFromLeftEdge(in app: XCUIApplication) throws {
            let frame = app.frame
            guard frame.width > 0, frame.height > 0 else {
                throw GestureError.gestureFailed("Cannot determine application frame for back gesture")
            }

            let start = app.coordinate(withNormalizedOffset: .zero)
                .withOffset(CGVector(dx: 2, dy: frame.height / 2))
            let end = app.coordinate(withNormalizedOffset: .zero)
                .withOffset(CGVector(dx: min(frame.width * 0.75, frame.width - 2), dy: frame.height / 2))
            start.press(
                forDuration: 0.05,
                thenDragTo: end,
                withVelocity: .default,
                thenHoldForDuration: 0
            )
        }

        public func pressButton(_ button: String) throws {
            switch button.lowercased() {
            case "home":
                try pressHome()
            case "recent":
                try openRecentApps()
            case "back":
                try pressBack()
            case "menu", "power", "volume_up", "volume_down":
                throw GestureError.notSupported("iOS simulator button: \(button)")
            default:
                throw GestureError.notSupported("Button: \(button)")
            }
        }

        public func openRecentApps() throws {
            try runOnMainThread {
                let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
                let screenSize = springboard.frame.size
                let startCoordinate = springboard.coordinate(withNormalizedOffset: .zero)
                    .withOffset(CGVector(dx: screenSize.width / 2, dy: screenSize.height - 5))
                let endCoordinate = springboard.coordinate(withNormalizedOffset: .zero)
                    .withOffset(CGVector(dx: screenSize.width / 2, dy: screenSize.height * 0.4))
                startCoordinate.press(
                    forDuration: 0.05,
                    thenDragTo: endCoordinate,
                    withVelocity: .default,
                    thenHoldForDuration: 1.0
                )
            }
        }

        // MARK: - App Control

        public func launchApp(bundleId: String) throws {
            try runOnMainThread {
                let app = XCUIApplication(bundleIdentifier: bundleId)
                app.launch()
            }
        }

        public func terminateApp(bundleId: String) throws {
            try runOnMainThread {
                let app = XCUIApplication(bundleIdentifier: bundleId)
                app.terminate()
            }
        }

        public func activateApp(bundleId: String) throws {
            try runOnMainThread {
                let app = XCUIApplication(bundleIdentifier: bundleId)
                app.activate()
            }
        }

        public func updateApplication(bundleId: String) {
            runOnMainThreadNonThrowing({
                let app = XCUIApplication(bundleIdentifier: bundleId)
                self.ownedApplication = app
                self.application = app
            }, fallback: ())
        }

    #else
        /// Non-iOS stub implementation
        private let elementLocator: ElementLocating

        public init(elementLocator: ElementLocating) {
            self.elementLocator = elementLocator
        }

        public func tap(x _: Double, y _: Double, duration _: TimeInterval = 0) throws {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func doubleTap(x _: Double, y _: Double) throws {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func longPress(x _: Double, y _: Double, duration _: TimeInterval) throws {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func swipe(
            startX _: Double,
            startY _: Double,
            endX _: Double,
            endY _: Double,
            duration _: TimeInterval
        )
            throws
        {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func drag(
            startX _: Double,
            startY _: Double,
            endX _: Double,
            endY _: Double,
            pressDuration _: TimeInterval,
            dragDuration _: TimeInterval,
            holdDuration _: TimeInterval
        )
            throws
        {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func pinch(centerX _: Double, centerY _: Double, scale _: Double, duration _: TimeInterval) throws {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func typeText(text _: String) throws {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func setText(resourceId _: String, text _: String) throws {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func clearText(resourceId _: String?) throws {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func selectAll() throws {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func performImeAction(_: String) throws {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func keyboard(action _: String) throws -> Bool {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func performAction(_: String, resourceId _: String?, label _: String?) throws {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func getScreenshot() throws -> Data {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func setOrientation(_: String) throws {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func getOrientation() -> String {
            return "unknown"
        }

        public func clipboard(action _: String, text _: String?) throws -> String? {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func pressHome() throws {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func pressBack() throws {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func pressButton(_: String) throws {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func openRecentApps() throws {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func launchApp(bundleId _: String) throws {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func terminateApp(bundleId _: String) throws {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func activateApp(bundleId _: String) throws {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func updateApplication(bundleId _: String) {
            // no-op on non-iOS
        }
    #endif
}
