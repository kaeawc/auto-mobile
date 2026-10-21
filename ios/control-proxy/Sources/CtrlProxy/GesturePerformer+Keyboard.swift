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
        public func performImeAction(_ action: String) throws {
            guard let app = resolveTextInputApp() else {
                throw GestureError.noApplication
            }

            try requireKeyboardFocus(
                app: app,
                context: "ensure a text field is focused before performing an IME action"
            )

            switch action.lowercased() {
            case "done", "go", "search", "send", "next":
                try catchingObjCException {
                    let keyboard = app.keyboards.firstMatch.exists
                        ? app.keyboards.firstMatch : self.springboard.keyboards.firstMatch
                    let keyboardVisible = keyboard.exists
                    let focusedField: ImeFocusedField
                    if let focused = resolveFocusedTextElement(app: app) {
                        focusedField = focused.elementType == .textView ? .multiline : .singleLine
                    } else {
                        focusedField = keyboardVisible ? .unresolved : .absent
                    }
                    let keys = keyboardVisible ? keyboard.buttons.matching(NSPredicate(
                        format: "identifier IN[c] %@ OR label IN[c] %@",
                        Self.submitButtonNames,
                        Self.submitButtonNames
                    )).allElementsBoundByIndex : []
                    let labels = keys.map { (label: $0.label, identifier: $0.identifier, isEnabled: $0.isEnabled) }
                    switch Self.imeActionDecision(
                        action: action,
                        focusedField: focusedField,
                        keyboardVisible: keyboardVisible,
                        keys: labels
                    ) {
                    case let .tapKey(index):
                        keys[index].tap()
                    case .typeReturn:
                        app.typeText("\n")
                    case let .notAvailable(reason):
                        throw GestureError.notSupported(reason)
                    }
                }
            case "previous":
                try catchingObjCException {
                    app.typeKey(.tab, modifierFlags: .shift)
                }
            default:
                throw GestureError.notSupported("IME action: \(action)")
            }
        }

        public func keyboard(action: String) async throws -> KeyboardActionResult {
            guard let app = resolveTextInputApp() else {
                throw GestureError.noApplication
            }

            switch action.lowercased() {
            case "detect":
                return KeyboardActionResult(open: isKeyboardVisible(app: app))
            case "open":
                if isKeyboardVisible(app: app) {
                    return KeyboardActionResult(open: true)
                }
                guard let focused = resolveFocusedTextElement(app: app) else {
                    throw GestureError.notSupported("No focused text input to open keyboard")
                }
                try catchingObjCException {
                    focused.tap()
                }
                return try KeyboardActionResult(open: await waitForKeyboardVisibility(app: app, expected: true))
            case "close":
                return try await closeKeyboard(app: app, clock: keyboardClock)
            default:
                throw GestureError.notSupported("Keyboard action: \(action)")
            }
        }

        private func closeKeyboard<C: Clock>(app: XCUIApplication, clock: C)
            async throws -> KeyboardActionResult where C.Duration == Duration
        {
            let closeDeadline = clock.now.advanced(by: .milliseconds(3500))
            if !isKeyboardVisible(app: app) {
                return KeyboardActionResult(open: false)
            }

            let isMultiline = keyboardCloseIsMultiline(app: app)
            let hasSubmitKey = !isMultiline && keyboardHasSubmitKey(app: app)
            let enabledKey = enabledKeyboardCloseKey(
                app: app, isMultiline: isMultiline, closeDeadline: closeDeadline, clock: clock
            )

            for attempt in Self.closeAttemptOrder(
                hasEnabledMatch: enabledKey != nil,
                hasSubmitKey: hasSubmitKey,
                isMultiline: isMultiline
            ) {
                if !isKeyboardVisible(app: app) {
                    return KeyboardActionResult(open: false)
                }
                guard clock.now < closeDeadline else {
                    break
                }
                let method: String
                do {
                    switch attempt {
                    case .matchedButton:
                        guard let enabledKey else { continue }
                        method = enabledKey.method
                        try catchingObjCException { enabledKey.element.tap() }
                    case .newline:
                        method = "returnKey"
                        try catchingObjCException { app.typeText("\n") }
                    case .escape:
                        method = "escape"
                        try typeKeyboardKey(.escape, app: app)
                    }
                } catch {
                    print("[GesturePerformer] keyboard close \(attempt) failed: \(error)")
                }
                if try await waitForKeyboardClose(app: app, closeDeadline: closeDeadline, clock: clock) {
                    return KeyboardActionResult(open: false, method: method)
                }
            }
            let open = isKeyboardVisible(app: app)
            return KeyboardActionResult(
                open: open,
                error: open && isMultiline ? Self.multilineCloseError : nil
            )
        }

        /// Return may insert content in a text view; failed focus reads remain conservative.
        private func keyboardCloseIsMultiline(app: XCUIApplication) -> Bool {
            do {
                return try catchingObjCException {
                    let focused = app.descendants(matching: .any)
                        .matching(NSPredicate(format: "hasKeyboardFocus == true"))
                        .firstMatch
                    return focused.exists && focused.elementType == .textView
                }
            } catch {
                print("[GesturePerformer] keyboard close focus lookup failed: \(error)")
                return true
            }
        }

        private func keyboardHasSubmitKey(app: XCUIApplication) -> Bool {
            do {
                return try catchingObjCException {
                    app.keyboards.buttons.matching(NSPredicate(
                        format: "identifier IN[c] %@ OR label IN[c] %@",
                        Self.submitButtonNames,
                        Self.submitButtonNames
                    )).firstMatch.exists
                }
            } catch {
                print("[GesturePerformer] keyboard close submit key lookup failed: \(error)")
                return false
            }
        }

        private func enabledKeyboardCloseKey<C: Clock>(
            app: XCUIApplication, isMultiline: Bool, closeDeadline: C.Instant, clock: C
        )
            -> (element: XCUIElement, method: String)? where C.Duration == Duration
        {
            var enabledKey: (element: XCUIElement, method: String)?
            do {
                let keys = try catchingObjCException {
                    app.keyboards.buttons.matching(NSPredicate(
                        format: "identifier IN[c] %@ OR label IN[c] %@",
                        Self.closeButtonNames,
                        Self.closeButtonNames
                    )).allElementsBoundByIndex
                }
                var labels: [(label: String, identifier: String)] = []
                for key in keys {
                    guard clock.now < closeDeadline else { break }
                    try labels.append(catchingObjCException { (label: key.label, identifier: key.identifier) })
                }
                for candidate in Self.closeKeyCandidates(labels, isMultiline: isMultiline) {
                    guard clock.now < closeDeadline else { break }
                    let key = keys[candidate.index]
                    if try catchingObjCException({ key.isEnabled }) {
                        enabledKey = (element: key, method: candidate.method)
                        break
                    }
                }
            } catch {
                print("[GesturePerformer] keyboard close key lookup failed: \(error)")
            }

            return enabledKey
        }

        private func waitForKeyboardVisibility(
            app: XCUIApplication,
            expected: Bool,
            timeout: TimeInterval = 1.0,
            interval: TimeInterval = 0.05
        )
            async throws -> Bool
        {
            try await KeyboardWait.visibility(
                clock: keyboardClock,
                expected: expected,
                timeout: .seconds(timeout),
                interval: .seconds(interval),
                probe: { self.isKeyboardVisible(app: app) }
            )
        }

        private func waitForKeyboardClose<C: Clock>(
            app: XCUIApplication, closeDeadline: C.Instant, clock: C
        )
            async throws -> Bool where C.Duration == Duration
        {
            try await KeyboardWait.close(clock: clock, closeDeadline: closeDeadline) {
                self.isKeyboardVisible(app: app)
            }
        }

        func isKeyboardVisible(app: XCUIApplication) -> Bool {
            catchingObjCExceptionNonThrowing({
                app.keyboards.firstMatch.exists || self.springboard.keyboards.firstMatch.exists
            }, fallback: false)
        }

        private func typeKeyboardKey(_ key: XCUIKeyboardKey, app: XCUIApplication) throws {
            try catchingObjCException {
                app.typeKey(key, modifierFlags: [])
            }
        }
    }
#endif
