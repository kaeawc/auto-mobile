import Foundation
#if canImport(XCTest) && os(iOS)
    import XCTest
#endif

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

        public init(application: XCUIApplication? = nil, elementLocator: ElementLocating) {
            self.application = application
            self.elementLocator = elementLocator
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

        public func typeText(text: String) throws {
            guard let app = application else {
                throw GestureError.noApplication
            }

            // Pre-check keyboard focus via predicate query to avoid XCUITest assertion
            // failure ("Neither element nor any descendant has keyboard focus") which
            // tears down the test and kills the CtrlProxy service.
            // Note: snapshot.hasFocus reflects UIKit's focus system (tvOS/iPad), not
            // keyboard input focus on iPhone — hasKeyboardFocus is predicate-only.
            let hasFocus: Bool = runOnMainThread {
                app.descendants(matching: .any)
                    .matching(NSPredicate(format: "hasKeyboardFocus == true"))
                    .firstMatch
                    .exists
            }
            guard hasFocus else {
                throw GestureError.gestureFailed(
                    "No element has keyboard focus — ensure a text field is focused before typing"
                )
            }

            runOnMainThread {
                app.typeText(text)
            }
        }

        public func setText(resourceId: String, text: String) throws {
            guard let app = application else {
                throw GestureError.noApplication
            }
            guard let element = elementLocator.findElement(byResourceId: resourceId) as? XCUIElement else {
                throw GestureError.elementNotFound(resourceId)
            }

            try runOnMainThread {
                element.tap()

                // Poll for keyboard focus — appearance is async after tap
                let deadline = Date().addingTimeInterval(0.2)
                var hasFocus = false
                while !hasFocus && Date() < deadline {
                    hasFocus = app.descendants(matching: .any)
                        .matching(NSPredicate(format: "hasKeyboardFocus == true"))
                        .firstMatch
                        .exists
                    if !hasFocus {
                        RunLoop.current.run(until: Date().addingTimeInterval(0.02))
                    }
                }
                guard hasFocus else {
                    throw GestureError.gestureFailed(
                        "Element '\(resourceId)' did not receive keyboard focus after tap"
                    )
                }

                // Select all and delete existing text via Cmd+A, Delete (O(1))
                if let existingText = element.value as? String, !existingText.isEmpty {
                    app.typeKey("a", modifierFlags: .command)
                    app.typeKey(.delete, modifierFlags: [])
                }

                element.typeText(text)
            }
        }

        public func clearText(resourceId: String? = nil) throws {
            guard let app = application else {
                throw GestureError.noApplication
            }

            if let resourceId = resourceId {
                guard let element = elementLocator.findElement(byResourceId: resourceId) as? XCUIElement else {
                    throw GestureError.elementNotFound(resourceId)
                }

                try runOnMainThread {
                    element.tap()

                    // Poll for keyboard focus — appearance is async after tap
                    let deadline = Date().addingTimeInterval(0.2)
                    var hasFocus = false
                    while !hasFocus && Date() < deadline {
                        hasFocus = app.descendants(matching: .any)
                            .matching(NSPredicate(format: "hasKeyboardFocus == true"))
                            .firstMatch
                            .exists
                        if !hasFocus {
                            RunLoop.current.run(until: Date().addingTimeInterval(0.02))
                        }
                    }
                    guard hasFocus else {
                        throw GestureError.gestureFailed(
                            "Element '\(resourceId)' did not receive keyboard focus after tap"
                        )
                    }

                    // Select all and delete via Cmd+A, Delete (O(1))
                    app.typeKey("a", modifierFlags: .command)
                    app.typeKey(.delete, modifierFlags: [])
                }
            } else {
                // Clear focused element via select-all then delete
                let hasFocus: Bool = runOnMainThread {
                    app.descendants(matching: .any)
                        .matching(NSPredicate(format: "hasKeyboardFocus == true"))
                        .firstMatch
                        .exists
                }
                guard hasFocus else {
                    throw GestureError.gestureFailed(
                        "No element has keyboard focus — ensure a text field is focused before clearing"
                    )
                }

                runOnMainThread {
                    app.typeKey("a", modifierFlags: .command)
                    app.typeKey(.delete, modifierFlags: [])
                }
            }
        }

        public func selectAll() throws {
            guard let app = application else {
                throw GestureError.noApplication
            }

            let hasFocus: Bool = runOnMainThread {
                app.descendants(matching: .any)
                    .matching(NSPredicate(format: "hasKeyboardFocus == true"))
                    .firstMatch
                    .exists
            }
            guard hasFocus else {
                throw GestureError.gestureFailed(
                    "No element has keyboard focus — ensure a text field is focused before selecting"
                )
            }

            runOnMainThread {
                app.typeKey("a", modifierFlags: .command)
            }
        }

        public func performImeAction(_ action: String) throws {
            guard let app = application else {
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
                guard let app = application else {
                    throw GestureError.noApplication
                }
                let clipboardText: String? = runOnMainThread {
                    UIPasteboard.general.string
                }
                guard clipboardText != nil, !clipboardText!.isEmpty else {
                    throw GestureError.clipboardEmpty
                }

                // Verify keyboard focus before pasting
                let hasFocus: Bool = runOnMainThread {
                    app.descendants(matching: .any)
                        .matching(NSPredicate(format: "hasKeyboardFocus == true"))
                        .firstMatch
                        .exists
                }
                guard hasFocus else {
                    throw GestureError.gestureFailed(
                        "No element has keyboard focus — ensure a text field is focused before pasting"
                    )
                }

                // Use Cmd+V for real paste — handles emoji, Unicode, and is a single operation
                runOnMainThread {
                    app.typeKey("v", modifierFlags: .command)
                }

                // iOS 16+ may show "Allow Paste" system alert
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
                let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
                let allowButton = springboard.buttons["Allow Paste"]
                if allowButton.waitForExistence(timeout: 0.5) {
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
