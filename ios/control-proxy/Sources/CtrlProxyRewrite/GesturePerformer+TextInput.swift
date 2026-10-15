import Foundation
import ObjCExceptionCatcher
import os
#if os(iOS)
    import UIKit
#endif
#if canImport(XCTest) && os(iOS)
    import XCTest
#endif

#if canImport(XCTest) && os(iOS)
    extension GesturePerformer {
        // MARK: - Text Input

        func fieldText(_ el: XCUIElement) -> String {
            do {
                let snapshot = try catchingObjCException { try el.snapshot() }
                return GesturePerformer.fieldText(
                    snapshotValue: snapshot.value as? String,
                    value: el.value as? String,
                    placeholderValue: snapshot.placeholderValue
                )
            } catch {
                // Text can still be read from the element when its snapshot is unavailable.
                logger.warning("Text field snapshot failed; reading element value: \(error)")
                let value = el.value as? String
                let placeholder = el.placeholderValue
                return value == placeholder ? "" : value ?? ""
            }
        }

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
        func resolveTextInputApp() -> XCUIApplication? {
            if let bundleId = elementLocator.foregroundBundleId, !bundleId.isEmpty {
                return XCUIApplication(bundleIdentifier: bundleId)
            }
            return application
        }

        func resolveNavigationApp() -> XCUIApplication? {
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

            try catchingObjCException {
                app.typeText(text)
            }
        }

        public func appendText(text: String) throws {
            try typeText(text: text)
        }

        public func setText(resourceId: String, text: String) async throws {
            guard let app = resolveTextInputApp() else {
                throw GestureError.noApplication
            }
            guard let element = elementLocator.findElement(byResourceId: resourceId) as? XCUIElement else {
                throw GestureError.elementNotFound(resourceId)
            }

            try await tapAndAwaitKeyboardFocus(app: app, element: element, resourceId: resourceId)
            try catchingObjCException {
                GesturePerformer.clearFocusedText(app: app, element: element)
                app.typeText(text)
            }
        }

        public func clearText(resourceId: String? = nil) async throws {
            guard let app = resolveTextInputApp() else {
                throw GestureError.noApplication
            }

            if let resourceId = resourceId {
                guard let element = elementLocator.findElement(byResourceId: resourceId) as? XCUIElement else {
                    throw GestureError.elementNotFound(resourceId)
                }
                try await tapAndAwaitKeyboardFocus(app: app, element: element, resourceId: resourceId)
                try catchingObjCException {
                    GesturePerformer.clearFocusedText(app: app, element: element)
                }
            } else {
                try requireKeyboardFocus(app: app, context: "ensure a text field is focused before clearing")
                let focused = resolveFocusedTextElement(app: app)
                try catchingObjCException {
                    if let focused = focused {
                        GesturePerformer.clearFocusedText(app: app, element: focused)
                    } else {
                        app.typeKey("a", modifierFlags: .command)
                        app.typeText(XCUIKeyboardKey.delete.rawValue)
                    }
                }
            }
        }

        /// Best-effort lookup of the focused text-input element so callers can check its type.
        /// Returns nil when no element is focused or the lookup fails for any reason, including
        /// an XCUITest exception (callers fall back to Cmd+A+Delete, which works for native inputs).
        func resolveFocusedTextElement(app: XCUIApplication) -> XCUIElement? {
            try? resolveFocusedTextElement(app: app, checkBudget: {})
        }

        /// Strict lookup for the arrow-key path. Returns nil only when no focused input is found;
        /// throws the budget's `arrowBudgetExhausted` unchanged, and an XCUITest exception during
        /// the scan as `GestureError.focusQueryFailed`, before any key is sent.
        func resolveFocusedTextElement(
            app: XCUIApplication, checkBudget: () throws -> Void
        )
            throws -> XCUIElement?
        {
            // Each XCUITest call is bridged on its own so the shared resolver maps the exception;
            // the outer bridge stays as the guard that an NSException can never escape the runner.
            try GesturePerformer.mappingFocusQueryException(phase: "element resolution") {
                try catchingObjCException {
                    try Self.resolveFocusedTextElement(
                        checkBudget: checkBudget,
                        predicateMatch: {
                            try catchingObjCException {
                                let match = app.descendants(matching: .any)
                                    .matching(NSPredicate(format: "hasKeyboardFocus == true")).firstMatch
                                return match.exists ? match : nil
                            }
                        },
                        nativeQueries: [
                            { try catchingObjCException { app.textFields.allElementsBoundByIndex } },
                            { try catchingObjCException { app.secureTextFields.allElementsBoundByIndex } },
                            { try catchingObjCException { app.textViews.allElementsBoundByIndex } },
                            { try catchingObjCException { app.searchFields.allElementsBoundByIndex } },
                        ],
                        otherQuery: {
                            let query = app.otherElements
                            let count = try catchingObjCException { query.count }
                            return (0 ..< count).lazy.map { query.element(boundBy: $0) }
                        },
                        nativeHasFocus: { candidate in
                            try catchingObjCException { (try? candidate.snapshot())?.hasFocus == true }
                        },
                        otherHasFocus: { candidate in
                            try catchingObjCException {
                                guard let snap = try? candidate.snapshot() else { return false }
                                return snap.hasFocus && GesturePerformer.snapshotLooksLikeTextInput(snap)
                            }
                        }
                    )
                }
            }
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
            for _ in 0 ..< clearViaDeletesMaxIterations {
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

            try catchingObjCException {
                app.typeKey("a", modifierFlags: .command)
            }
        }
    }
#endif
