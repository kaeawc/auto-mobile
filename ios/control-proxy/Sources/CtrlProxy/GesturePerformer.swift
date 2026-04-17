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
        /// do not. False positives would cause `clearViaDeletes` to send
        /// delete keys to a non-text element.
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
        private func detectKeyboardFocus(app: XCUIApplication) -> (Bool, String) {
            return runOnMainThread { [springboard] in
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
            let (hasFocus, strategy) = detectKeyboardFocus(app: app)
            let elapsedMs = Int(Date().timeIntervalSince(queryStart) * 1000)
            let appLabel = runOnMainThread { app.label }
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
                let result = detectKeyboardFocus(app: app)
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
            return runOnMainThread { [springboard] in
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
            }
        }

        public func setApplication(_ app: XCUIApplication) {
            ownedApplication = nil
            application = app
        }

        // MARK: - Main Thread Helper

        /// Executes a throwing closure on the main thread and returns the result.
        /// XCUITest APIs must be called on the main thread.
        private func runOnMainThread<T>(_ block: @escaping () throws -> T) throws -> T {
            if Thread.isMainThread {
                return try block()
            }

            var result: Result<T, Error>!
            DispatchQueue.main.sync {
                do {
                    result = try .success(block())
                } catch {
                    result = .failure(error)
                }
            }
            return try result.get()
        }

        /// Executes a non-throwing closure on the main thread and returns the result.
        private func runOnMainThread<T>(_ block: @escaping () -> T) -> T {
            if Thread.isMainThread {
                return block()
            }

            var result: T!
            DispatchQueue.main.sync {
                result = block()
            }
            return result
        }

        // MARK: - Tap Gestures

        public func tap(x: Double, y: Double, duration: TimeInterval = 0) throws {
            guard let app = application else {
                throw GestureError.noApplication
            }

            runOnMainThread {
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

            runOnMainThread {
                let coordinate = app.coordinate(withNormalizedOffset: .zero)
                    .withOffset(CGVector(dx: x, dy: y))
                coordinate.doubleTap()
            }
        }

        public func longPress(x: Double, y: Double, duration: TimeInterval) throws {
            guard let app = application else {
                throw GestureError.noApplication
            }

            runOnMainThread {
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

            runOnMainThread {
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
            dragDuration _: TimeInterval,
            holdDuration: TimeInterval
        )
            throws
        {
            guard let app = application else {
                throw GestureError.noApplication
            }

            runOnMainThread {
                let startCoordinate = app.coordinate(withNormalizedOffset: .zero)
                    .withOffset(CGVector(dx: startX, dy: startY))
                let endCoordinate = app.coordinate(withNormalizedOffset: .zero)
                    .withOffset(CGVector(dx: endX, dy: endY))

                // Press, drag, and hold
                startCoordinate.press(
                    forDuration: pressDuration,
                    thenDragTo: endCoordinate,
                    withVelocity: .default,
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

        public func typeText(text: String) throws {
            guard let app = resolveTextInputApp() else {
                throw GestureError.noApplication
            }

            try requireKeyboardFocus(app: app, context: "ensure a text field is focused before typing")

            runOnMainThread {
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
                // Clear any existing text per-character so RN's onChangeText
                // fires for each delete (see clearViaDeletes for rationale).
                GesturePerformer.clearViaDeletes(element: element)
                element.typeText(text)
            }
        }

        /// Delete-burst size for `clearViaDeletes`. Sized to cover typical
        /// form-field content (email, name, phone, password, address, OTP)
        /// without exceeding what XCUITest's keyboard input pipeline can
        /// ship as a single `typeText` call before falling back to touch
        /// synthesis — which, empirically, can trigger spurious home
        /// transitions during very long bursts. 50 chars is a safe cap.
        /// Overkill deletes on an empty field are harmless no-ops.
        private static let clearViaDeletesBurstSize = 50

        /// Clear a text element by positioning the cursor at the end of
        /// content then sending a large fixed-size burst of delete
        /// keystrokes. Returns the burst size (callers typically ignore it).
        ///
        /// **Why not Cmd+A + Delete?** Bypasses React Native's
        /// `onChangeText` bridge — the native buffer clears but RN JS state
        /// stays stale.
        ///
        /// **Why a fixed burst and not a progress-driven loop?**
        /// `element.value` on RN `TextInput` wrappers returns the
        /// accessibility identifier (e.g. `"email-sign-in-email-input"`)
        /// instead of the real content, so count- and equality-based
        /// progress detection is unreliable. A single generous burst with
        /// the cursor at the end sidesteps both problems.
        ///
        /// **Cursor positioning.** A bare tap at the right edge places the
        /// cursor at end-of-content (iOS snaps to the last character when
        /// the tap lands in trailing padding). We use `tap()` rather than
        /// `doubleTap()` because doubleTap on empty padding past the text
        /// is a no-op and doesn't reposition the cursor. Coordinate-based
        /// so it fires even when the element already has first-responder
        /// focus.
        @discardableResult
        private static func clearViaDeletes(element: XCUIElement) -> Int {
            element.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
            element.typeText(String(
                repeating: XCUIKeyboardKey.delete.rawValue,
                count: clearViaDeletesBurstSize
            ))
            return clearViaDeletesBurstSize
        }

        /// Resolve the currently-focused text-input element for the bare
        /// `clearText` / `selectAll` / `performImeAction` paths. Mirrors
        /// `detectKeyboardFocus`'s first two strategies but returns the
        /// actual `XCUIElement` so callers can dispatch `typeText` against
        /// it (and have React Native's `onChangeText` bridge fire).
        ///
        /// Strategy 1 (predicate): `hasKeyboardFocus == true` — cheap, works
        /// for standard UIKit apps.
        ///
        /// Strategy 2 (snapshot walk): iterate candidate text-input element
        /// types (`textFields`, `secureTextFields`, `textViews`,
        /// `searchFields`) and check each element's snapshot for
        /// `hasFocus`. Catches RN `TextInput`s whose UITextField wrapper
        /// doesn't propagate `hasKeyboardFocus` but does report
        /// `snapshot.hasFocus`. More expensive (one `.snapshot()` per
        /// candidate) but only runs when the predicate misses.
        ///
        /// Strategy 3 (`.other` snapshot walk): `detectKeyboardFocus` treats
        /// focused `.other` snapshots as text inputs when they expose a
        /// non-empty `value` or `placeholderValue` (see
        /// `snapshotLooksLikeTextInput`). Mirror that here so flows where
        /// focus is exposed only via an `.other` wrapper can be resolved —
        /// otherwise `requireKeyboardFocus` passes and `clearText` throws
        /// because this method returns nil.
        ///
        /// No keyboard-visibility fallback here: visibility proves focus
        /// exists somewhere but doesn't name an element, and we need an
        /// element to dispatch deletes against. Callers that hit that case
        /// should use `clearText(resourceId:)` with a concrete selector.
        private func resolveFocusedTextElement(app: XCUIApplication) -> XCUIElement? {
            return runOnMainThread {
                // Strategy 1: predicate
                let byPredicate = app.descendants(matching: .any)
                    .matching(NSPredicate(format: "hasKeyboardFocus == true"))
                    .firstMatch
                if byPredicate.exists {
                    return byPredicate
                }

                // Strategy 2: per-type snapshot traversal
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
                        if snap.hasFocus {
                            return candidate
                        }
                    }
                }

                // Strategy 3: .other elements that look like text inputs
                let otherQuery = app.otherElements
                let otherCount = otherQuery.count
                if otherCount > 0 {
                    for i in 0..<otherCount {
                        let candidate = otherQuery.element(boundBy: i)
                        guard let snap = try? candidate.snapshot() else { continue }
                        if snap.hasFocus && GesturePerformer.snapshotLooksLikeTextInput(snap) {
                            return candidate
                        }
                    }
                }

                return nil
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
                    GesturePerformer.clearViaDeletes(element: element)
                }
                return
            }

            // Bare clearText: require focus (3-strategy), then resolve the
            // focused element to dispatch per-character deletes against.
            // Single code path — no Cmd+A/Delete fallback, because that
            // path bypasses RN's onChangeText bridge.
            try requireKeyboardFocus(app: app, context: "ensure a text field is focused before clearing")
            guard let focused = resolveFocusedTextElement(app: app) else {
                let diag = buildFocusDiagnostic(app: app, reason: "clearText: focus confirmed but no XCUITest-visible element resolved")
                gestureLog.error("\(diag, privacy: .public)")
                throw GestureError.gestureFailed(
                    "clearText could not resolve a focused text element. Pass resourceId to clear a specific field. Diagnostic: \(diag)"
                )
            }
            runOnMainThread {
                GesturePerformer.clearViaDeletes(element: focused)
            }
        }

        public func selectAll() throws {
            guard let app = resolveTextInputApp() else {
                throw GestureError.noApplication
            }

            try requireKeyboardFocus(app: app, context: "ensure a text field is focused before selecting")

            runOnMainThread {
                app.typeKey("a", modifierFlags: .command)
            }
        }

        public func performImeAction(_ action: String) throws {
            guard let app = resolveTextInputApp() else {
                throw GestureError.noApplication
            }

            switch action.lowercased() {
            case "done", "go", "search", "send", "next":
                runOnMainThread {
                    app.typeText("\n")
                }
            case "previous":
                runOnMainThread {
                    app.typeKey(.tab, modifierFlags: .shift)
                }
            default:
                throw GestureError.notSupported("IME action: \(action)")
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

            return runOnMainThread {
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
            return runOnMainThread {
                let device = XCUIDevice.shared

                switch device.orientation {
                case .portrait: return "portrait"
                case .portraitUpsideDown: return "portrait_upside_down"
                case .landscapeLeft: return "landscape_left"
                case .landscapeRight: return "landscape_right"
                default: return "unknown"
                }
            }
        }

        // MARK: - Clipboard

        public func clipboard(action: String, text: String?) throws -> String? {
            switch action {
            case "get":
                return runOnMainThread {
                    UIPasteboard.general.string
                }

            case "copy":
                guard let text = text else {
                    throw GestureError.missingParameter("text required for copy")
                }
                runOnMainThread {
                    UIPasteboard.general.string = text
                }
                return nil

            case "clear":
                runOnMainThread {
                    UIPasteboard.general.items = []
                }
                return nil

            case "paste":
                // Use foreground-app resolution (#1925) — the clipboard paste
                // path also needs to query the correct app for hasKeyboardFocus.
                guard let app = resolveTextInputApp() else {
                    throw GestureError.noApplication
                }
                let clipboardText: String? = runOnMainThread {
                    UIPasteboard.general.string
                }
                guard let pasteText = clipboardText, !pasteText.isEmpty else {
                    throw GestureError.clipboardEmpty
                }

                try requireKeyboardFocus(app: app, context: "ensure a text field is focused before pasting")

                // Use Cmd+V for real paste — handles emoji, Unicode, and is a single operation
                runOnMainThread {
                    app.typeKey("v", modifierFlags: .command)
                }

                // iOS 16+ may show "Allow Paste" system alert (label is English-only;
                // no reliable cross-locale alternative exists without button index)
                handlePasteAlert()
                return nil

            default:
                throw GestureError.unsupportedAction(action)
            }
        }

        /// Handle iOS 16+ "Allow Paste" system alert that appears when pasting
        /// content set by another process. Checks SpringBoard for the alert button
        /// and taps it if present. No-op on iOS 15 or if already permitted.
        private func handlePasteAlert() {
            runOnMainThread {
                let allowButton = self.springboard.buttons["Allow Paste"]
                // Quick existence check avoids full 0.5s wait when no alert is present
                if allowButton.exists || allowButton.waitForExistence(timeout: 0.3) {
                    allowButton.tap()
                }
            }
        }

        public func pressHome() throws {
            runOnMainThread {
                XCUIDevice.shared.press(.home)
            }
        }

        public func openRecentApps() throws {
            runOnMainThread {
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
            runOnMainThread {
                let app = XCUIApplication(bundleIdentifier: bundleId)
                app.launch()
            }
        }

        public func terminateApp(bundleId: String) throws {
            runOnMainThread {
                let app = XCUIApplication(bundleIdentifier: bundleId)
                app.terminate()
            }
        }

        public func activateApp(bundleId: String) throws {
            runOnMainThread {
                let app = XCUIApplication(bundleIdentifier: bundleId)
                app.activate()
            }
        }

        public func updateApplication(bundleId: String) {
            runOnMainThread {
                let app = XCUIApplication(bundleIdentifier: bundleId)
                self.ownedApplication = app
                self.application = app
            }
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
