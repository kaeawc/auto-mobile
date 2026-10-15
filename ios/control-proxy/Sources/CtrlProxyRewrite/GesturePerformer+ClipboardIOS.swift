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
        private static func writeShadow(_ value: String?) {
            clipboardShadow = value
        }

        /// Read `UIPasteboard.general.string` with a bounded timeout. The
        /// pasteboard read can deadlock the runner on iOS 16+ when a
        /// privacy alert is presented but no user is available to dismiss
        /// it. Returns `.unavailable` on timeout instead of blocking forever.
        private static func readPasteboardWithTimeout(_ timeout: DispatchTimeInterval) -> ClipboardReadResult {
            // Skip the read entirely if there are no strings — `hasStrings`
            // is a non-prompting synchronous check.
            guard UIPasteboard.general.hasStrings else { return .empty }
            let semaphore = DispatchSemaphore(value: 0)
            let box = ClipboardReadBox()
            DispatchQueue.global(qos: .userInitiated).async {
                box.text = UIPasteboard.general.string
                semaphore.signal()
            }
            if semaphore.wait(timeout: .now() + timeout) == .timedOut {
                return .unavailable
            }
            guard let text = box.text else { return .unavailable }
            return .value(text)
        }

        /// `@unchecked Sendable`: the `semaphore.signal()`/`wait()` pair in
        /// `readPasteboardWithTimeout` establishes a happens-before edge between the
        /// write on the global queue and the read on the caller, so the single mutable
        /// `text` needs no lock. Required because `DispatchQueue.async`'s closure is
        /// `@Sendable` and captures the box.
        private final class ClipboardReadBox: @unchecked Sendable {
            var text: String?
        }

        public func clipboard(action: String, text: String?) throws -> String? {
            switch action {
            case "get":
                let readResult = GesturePerformer.readPasteboardWithTimeout(.milliseconds(500))
                return try GesturePerformer.resolveClipboardGet(readResult: readResult)

            case "copy":
                guard let text = text else {
                    throw GestureError.missingParameter("text required for copy")
                }
                try catchingObjCException {
                    UIPasteboard.general.string = text
                }
                GesturePerformer.writeShadow(text)
                return nil

            case "clear":
                try catchingObjCException {
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
                // Bounded read; an unreadable pasteboard still pastes and the host verifies the field.
                try GesturePerformer.resolveClipboardPaste(
                    readResult: GesturePerformer.readPasteboardWithTimeout(.milliseconds(500))
                )

                try requireKeyboardFocus(app: app, context: "ensure a text field is focused before pasting")

                // Use Cmd+V for real paste — handles emoji, Unicode, and is a single operation
                try catchingObjCException {
                    app.typeKey("v", modifierFlags: .command)
                }

                // iOS 16+ may show a paste-permission system alert; match known
                // UIKitCore allow labels across locales without selecting deny actions.
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
            try catchingObjCException {
                let allowButton = self.springboard.buttons["Allow Paste"]
                // Quick existence check avoids full 0.5s wait when no alert is present
                if allowButton.exists || allowButton.waitForExistence(timeout: 0.3) {
                    allowButton.tap()
                    return
                }
                // Immediate fallback: no additional wait when the English check misses.
                if let localizedAllowButton = self.springboard.buttons.allElementsBoundByIndex.first(where: {
                    PasteAlertLabelMatcher.isAllowPasteLabel($0.label)
                }) {
                    localizedAllowButton.tap()
                }
            }
        }
    }
#endif
