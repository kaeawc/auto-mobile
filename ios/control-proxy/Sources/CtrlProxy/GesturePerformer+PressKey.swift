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
        @discardableResult
        public func pressKey(key: String, modifiers: [String]) async throws -> Bool? {
            try await pressKeyOutcome(key: key, modifiers: modifiers).verified
        }

        public func pressKeyOutcome(key: String, modifiers: [String]) async throws -> PressKeyOutcome {
            var warning: String?
            let verified = try await performPressKey(key: key, modifiers: modifiers, warning: &warning)
            return PressKeyOutcome(verified: verified, warning: warning)
        }

        private func performPressKey(key: String, modifiers: [String], warning: inout String?) async throws -> Bool? {
            let memo = consumeCaretMemo(key: key, modifiers: modifiers)
            let normalizedKey = key.lowercased()
            try GesturePerformer.validateDestructiveKeyModifiers(normalizedKey: normalizedKey, modifiers: modifiers)

            guard let app = resolveTextInputApp() else {
                throw GestureError.noApplication
            }
            let bundleId = elementLocator.foregroundBundleId

            let keyboardKey: XCUIKeyboardKey
            switch normalizedKey {
            case "enter":
                keyboardKey = .return
            case "tab":
                keyboardKey = .tab
            case "escape":
                keyboardKey = .escape
            case "backspace":
                keyboardKey = .delete
            case "delete":
                keyboardKey = .forwardDelete
            case "arrow_up":
                keyboardKey = .upArrow
            case "arrow_down":
                keyboardKey = .downArrow
            case "arrow_left":
                keyboardKey = .leftArrow
            case "arrow_right":
                keyboardKey = .rightArrow
            default:
                throw GestureError.notSupported("Keyboard key: \(key)")
            }

            var modifierFlags: XCUIElement.KeyModifierFlags = []
            for modifier in Set(modifiers.map { $0.lowercased() }) {
                switch modifier {
                case "shift":
                    modifierFlags.formUnion(.shift)
                case "ctrl":
                    modifierFlags.formUnion(.control)
                case "alt":
                    modifierFlags.formUnion(.option)
                case "meta":
                    modifierFlags.formUnion(.command)
                default:
                    throw GestureError.notSupported("Keyboard modifier: \(modifier)")
                }
            }

            let isDestructiveKey = normalizedKey == "backspace" || normalizedKey == "delete"
            let isHorizontalArrow = normalizedKey == "arrow_left" || normalizedKey == "arrow_right"
            let isPlainHorizontalArrow = isHorizontalArrow && modifierFlags.isEmpty
            if isPlainHorizontalArrow {
                return try GesturePerformer.performHorizontalArrow(
                    clock: keyboardClock, key: normalizedKey,
                    requireFocus: {
                        GesturePhaseDiagnostics.current?.begin("focusCheck")
                        try self.requireKeyboardFocus(
                            app: app, context: "ensure a text field is focused before pressing a key", forKeyPress: true
                        )
                    },
                    resolveInput: { checkBudget in
                        GesturePhaseDiagnostics.current?.begin("elementResolution")
                        let element = try self.resolveFocusedTextElement(app: app, checkBudget: checkBudget)
                        try checkBudget()
                        GesturePhaseDiagnostics.current?.begin("valueRead")
                        let original = try GesturePerformer.mappingFocusQueryException(phase: "value read") {
                            try element.map { element in
                                try catchingObjCException { self.fieldText(element) }
                            }
                        }
                        return (element, original)
                    },
                    probeCaret: { element, original in
                        GesturePhaseDiagnostics.current?.begin("caretProbe")
                        return try self.probeCaretIndex(app: app, focusedElement: element, original: original)
                    },
                    sendKey: {
                        GesturePhaseDiagnostics.current?.begin("keyDelivery")
                        try catchingObjCException { app.typeKey(keyboardKey, modifierFlags: []) }
                    },
                    retryKey: { element in
                        GesturePhaseDiagnostics.current?.begin("keyDelivery")
                        try catchingObjCException { element.typeKey(keyboardKey, modifierFlags: []) }
                    },
                    readValue: { element in
                        GesturePhaseDiagnostics.current?.begin("outcomeConfirmation")
                        return try catchingObjCException { self.fieldText(element) }
                    },
                    restoreValue: { element, original in
                        try self.restoreForwardDeleteProbe(
                            app: app, focusedElement: element, original: original, marker: ""
                        )
                    },
                    knownCaret: { memo?.caret(bundleId: bundleId, value: $0) },
                    verifiedCaret: { self.rememberCaret(bundleId: bundleId, value: $0, index: $1) }
                )
            }

            GesturePhaseDiagnostics.current?.begin("focusCheck")
            try requireKeyboardFocus(
                app: app, context: "ensure a text field is focused before pressing a key", forKeyPress: true
            )

            GesturePhaseDiagnostics.current?.begin("elementResolution")
            let focusedElement = isDestructiveKey ? resolveFocusedTextElement(app: app) : nil
            let focusedKind = try focusedElement.map { element in
                try catchingObjCException { GesturePerformer.focusedElementKind(element.elementType) }
            }
            GesturePhaseDiagnostics.current?.begin("valueRead")
            let valueBeforeKeyPress = try focusedElement.map { element in
                try catchingObjCException { fieldText(element) }
            }
            let caretBefore: Int?
            if normalizedKey == "delete", let focusedElement {
                GesturePhaseDiagnostics.current?.begin("caretProbe")
                caretBefore = try probeCaretIndex(
                    app: app, focusedElement: focusedElement, original: valueBeforeKeyPress
                )
            } else {
                caretBefore = nil
            }

            if isDestructiveKey, !GesturePerformer.canVerifyDestructiveKey(focusedValue: valueBeforeKeyPress) {
                throw GestureError.gestureFailed(
                    "Key '\(key)' was not delivered: focused field could not be observed"
                )
            }

            let expectedForwardDelete: String?
            if normalizedKey == "delete", let original = valueBeforeKeyPress, !original.isEmpty {
                guard let caretBefore else {
                    throw GestureError.gestureFailed(
                        "Forward delete unavailable: could not verify the caret position; use text replacement instead"
                    )
                }
                guard let expected = GesturePerformer.forwardDeleteResult(original: original, caretIndex: caretBefore)
                else {
                    throw GestureError.gestureFailed(
                        "Forward delete has no following character at the caret; move the caret left first"
                    )
                }
                expectedForwardDelete = expected
            } else {
                expectedForwardDelete = nil
            }

            GesturePhaseDiagnostics.current?.begin("keyDelivery")
            try catchingObjCException {
                if normalizedKey == "backspace" {
                    // Backspace uses text insertion on the focused field because app-level
                    // key delivery has not reliably reached it.
                    guard let focusedElement else {
                        throw GestureError.gestureFailed(
                            "Key '\(key)' was not delivered: focused field could not be observed"
                        )
                    }
                    focusedElement.typeText(keyboardKey.rawValue)
                } else if normalizedKey == "delete" {
                    // XCUI forward delete is a no-op on the simulator; use the
                    // verified Right Arrow + Backspace path below there.
                    #if !targetEnvironment(simulator)
                        app.typeKey(keyboardKey, modifierFlags: [])
                    #endif
                } else {
                    app.typeKey(keyboardKey, modifierFlags: modifierFlags)
                }
            }

            if isHorizontalArrow { return false }

            guard isDestructiveKey else {
                return nil
            }
            guard let focusedElement, let valueBeforeKeyPress else {
                throw GestureError.gestureFailed(
                    "Key '\(key)' was not delivered: focused field could not be observed"
                )
            }
            if GesturePerformer.destructiveKeyOutcome(before: valueBeforeKeyPress, after: valueBeforeKeyPress)
                == .boundaryNoOp
            {
                return nil
            }

            if normalizedKey == "delete" {
                GesturePhaseDiagnostics.current?.begin("outcomeConfirmation")
                let valueBeforeFallback = try catchingObjCException { fieldText(focusedElement) }
                if valueBeforeFallback == expectedForwardDelete { return nil }
                if valueBeforeFallback == valueBeforeKeyPress, let caretBefore {
                    try emulateForwardDelete(
                        app: app, focusedElement: focusedElement, original: valueBeforeKeyPress,
                        caretBefore: caretBefore
                    )
                } else {
                    throw GestureError.gestureFailed(
                        "Forward delete changed a different character; use text replacement instead"
                    )
                }
            }

            var valueAfterKeyPress = valueBeforeKeyPress
            GesturePhaseDiagnostics.current?.begin("postCondition")
            let satisfied = try await KeyboardWait.destructivePostCondition(clock: keyboardClock) {
                guard try catchingObjCException({ focusedElement.exists }) else {
                    if normalizedKey == "delete" {
                        throw GestureError.gestureFailed(
                            "Forward delete unavailable: focused field disappeared; use text replacement instead"
                        )
                    }
                    return true
                }
                valueAfterKeyPress = try catchingObjCException { self.fieldText(focusedElement) }
                if normalizedKey == "delete", valueAfterKeyPress == expectedForwardDelete {
                    return true
                }
                return normalizedKey == "backspace"
                    && GesturePerformer.destructiveKeyOutcome(
                        before: valueBeforeKeyPress, after: valueAfterKeyPress
                    ) == .deleted
            }
            if satisfied { return nil }

            if normalizedKey == "delete" {
                throw GestureError.gestureFailed(
                    "Forward delete did not remove the character after the caret: expected length \(expectedForwardDelete?.count ?? 0), observed \(valueAfterKeyPress.count); use text replacement instead"
                )
            }
            switch GesturePerformer.destructiveKeyPostCondition(
                kind: focusedKind ?? .unsupported, before: valueBeforeKeyPress, after: valueAfterKeyPress
            ) {
            case .failed:
                throw GestureError.gestureFailed(
                    "Key '\(key)' did not decrease text length: before \(valueBeforeKeyPress.count), observed \(valueAfterKeyPress.count)"
                )
            case .deliveredWithWarning:
                warning = GesturePerformer.destructiveKeyWarning(key: key)
                return nil
            case .delivered, .boundaryNoOp:
                return nil
            }
        }

        private func probeCaretIndex(
            app: XCUIApplication, focusedElement: XCUIElement, original: String?
        )
            throws -> Int?
        {
            guard let original, let marker = GesturePerformer.forwardDeleteMarker(for: original) else { return nil }
            do {
                let index = try catchingObjCException { () -> Int? in
                    focusedElement.typeText(marker)
                    let probed = fieldText(focusedElement)
                    guard let index = GesturePerformer.forwardDeleteMarkerIndex(
                        original: original, probed: probed, marker: marker
                    )
                    else { return nil }
                    focusedElement.typeText(XCUIKeyboardKey.delete.rawValue)
                    guard fieldText(focusedElement) == original else { return nil }
                    return index
                }
                if index != nil { return index }
            } catch {
                try restoreForwardDeleteProbe(
                    app: app, focusedElement: focusedElement, original: original, marker: marker
                )
                return nil
            }
            try restoreForwardDeleteProbe(
                app: app, focusedElement: focusedElement, original: original, marker: marker
            )
            return nil
        }

        private func emulateForwardDelete(
            app: XCUIApplication, focusedElement: XCUIElement, original: String, caretBefore: Int
        )
            throws
        {
            // The native forward-delete key is a no-op on some simulator runtimes. Move
            // one character right and backspace only after observing that movement.
            GesturePhaseDiagnostics.current?.begin("keyDelivery")
            try catchingObjCException { app.typeKey(.rightArrow, modifierFlags: []) }
            GesturePhaseDiagnostics.current?.begin("caretProbe")
            var caretAfter = try probeCaretIndex(app: app, focusedElement: focusedElement, original: original)
            if caretAfter == caretBefore {
                GesturePhaseDiagnostics.current?.begin("keyDelivery")
                try catchingObjCException { focusedElement.typeKey(.rightArrow, modifierFlags: []) }
                GesturePhaseDiagnostics.current?.begin("caretProbe")
                caretAfter = try probeCaretIndex(app: app, focusedElement: focusedElement, original: original)
            }
            guard caretAfter == caretBefore + 1 else {
                throw GestureError.gestureFailed(
                    "Forward delete unavailable: Right Arrow did not move the caret one character; use text replacement instead"
                )
            }
            GesturePhaseDiagnostics.current?.begin("keyDelivery")
            try catchingObjCException { focusedElement.typeText(XCUIKeyboardKey.delete.rawValue) }
        }

        private func restoreForwardDeleteProbe(
            app: XCUIApplication, focusedElement: XCUIElement, original: String, marker: String
        )
            throws
        {
            if (try? catchingObjCException({ fieldText(focusedElement) })) == original { return }

            if !marker.isEmpty,
               (try? catchingObjCException({ fieldText(focusedElement) }))?.contains(marker) == true
            {
                try? catchingObjCException {
                    focusedElement.typeText(XCUIKeyboardKey.delete.rawValue)
                }
                if (try? catchingObjCException({ fieldText(focusedElement) })) == original { return }
            }

            do {
                try catchingObjCException {
                    app.typeKey("a", modifierFlags: .command)
                    if original.isEmpty {
                        focusedElement.typeText(XCUIKeyboardKey.delete.rawValue)
                    } else {
                        focusedElement.typeText(original)
                    }
                }
            } catch {
                throw GestureError.gestureFailed("Forward-delete probe recovery failed: \(error)")
            }
            guard (try? catchingObjCException({ fieldText(focusedElement) })) == original else {
                throw GestureError.gestureFailed("Forward-delete probe recovery could not confirm the original text")
            }
        }
    }
#endif
