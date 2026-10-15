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
        static func focusedElementKind(_ type: XCUIElement.ElementType) -> FocusedElementKind {
            switch type {
            case .textField: return .textField
            case .secureTextField: return .secureTextField
            case .textView: return .textView
            case .searchField: return .searchField
            case .other: return .other
            default: return .unsupported
            }
        }

        /// `catchingObjCException` for methods that cannot propagate errors: a caught
        /// `NSException` is logged and `fallback` returned. The `main.sync` hop of the
        /// reference is gone (we run on main) but the XCUITest `NSException` guard
        /// remains necessary.
        func catchingObjCExceptionNonThrowing<T>(_ block: () -> T, fallback: T) -> T {
            do {
                return try catchingObjCException(block)
            } catch {
                print("[GesturePerformer] ObjC exception in non-throwing context: \(error)")
                return fallback
            }
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
        private static func focusedTextInputType(
            _ snapshot: XCUIElementSnapshot,
            forKeyPress: Bool = false,
            depth: Int = 0
        )
            -> XCUIElement.ElementType?
        {
            if depth > 64 { return nil }

            let type = snapshot.elementType
            let isKnownTextInput = type == .textField
                || type == .textView
                || type == .secureTextField
                || type == .searchField
            let isTextLikeOther = type == .other && snapshotLooksLikeTextInput(snapshot)

            if isFocusedSnapshotCandidate(
                hasFocus: snapshot.hasFocus,
                isKnownTextInput: isKnownTextInput,
                isOther: type == .other,
                hasTextInputEvidence: isTextLikeOther,
                forKeyPress: forKeyPress
            ) {
                return type
            }
            for child in snapshot.children {
                if let focusedType = focusedTextInputType(child, forKeyPress: forKeyPress, depth: depth + 1) {
                    return focusedType
                }
            }
            return nil
        }

        /// Heuristic for treating an `.other`-typed snapshot as a text-input
        /// wrapper. Text fields expose a non-empty `value` (current content)
        /// or a `placeholderValue` (hint text); plain buttons / containers
        /// do not.
        static func snapshotLooksLikeTextInput(_ snapshot: XCUIElementSnapshot) -> Bool {
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
        /// won.
        private func detectKeyboardFocus(app: XCUIApplication, forKeyPress: Bool = false) throws -> (Bool, String) {
            try catchingObjCException {
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
                if app.identifier != "com.apple.springboard",
                   let snapshot = try? app.snapshot(),
                   let focusedType = GesturePerformer.focusedTextInputType(snapshot, forKeyPress: forKeyPress)
                {
                    let keyboardVisible = isKeyboardVisible(app: app)
                    let focusType: SnapshotFocusElementType
                    switch focusedType {
                    case .textField: focusType = .textField
                    case .secureTextField: focusType = .secureTextField
                    case .searchField: focusType = .searchField
                    case .textView: focusType = .textView
                    default: focusType = .other
                    }
                    if GesturePerformer.acceptSnapshotFocus(
                        keyboardVisible: keyboardVisible, focusedElementType: focusType
                    ) {
                        return (true, "snapshot.hasFocus")
                    }
                    return (false, "snapshot.hasFocus-without-keyboard")
                }

                // Strategy 3: keyboard-visibility probe. Covers the case
                // where neither the predicate nor the snapshot picks up
                // focus (e.g., unknown/stale foreground bundle ID) but the
                // user-visible keyboard proves something owns first responder.
                if self.springboard.keyboards.firstMatch.exists || app.keyboards.firstMatch.exists {
                    return (true, "keyboard-visibility")
                }

                return (false, "none")
            }
        }

        /// Check that some element in the app has keyboard focus.
        /// Throws with a contextual error message if no focus is detected.
        /// On failure, the thrown error embeds a focus-diagnostic summary so
        /// it surfaces in the MCP response — not just in device logs.
        func requireKeyboardFocus(
            app: XCUIApplication, context: String, forKeyPress: Bool = false
        )
            throws
        {
            let queryStart = Date()
            let (hasFocus, strategy) = try detectKeyboardFocus(app: app, forKeyPress: forKeyPress)
            let elapsedMs = Int(Date().timeIntervalSince(queryStart) * 1000)
            print(
                "[GesturePerformer] requireKeyboardFocus hasFocus=\(hasFocus) strategy=\(strategy) context=\"\(context)\" elapsedMs=\(elapsedMs)"
            )

            guard hasFocus else {
                let appLabel = catchingObjCExceptionNonThrowing({ app.label }, fallback: "unknown")
                print("[GesturePerformer] requireKeyboardFocus appLabel=\(appLabel)")
                let diag = buildFocusDiagnostic(app: app, reason: "requireKeyboardFocus: \(context)")
                print("[GesturePerformer] \(diag)")
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
        func tapAndAwaitKeyboardFocus(
            app: XCUIApplication,
            element: XCUIElement,
            resourceId: String
        )
            async throws
        {
            let result = try await KeyboardWait.focus(
                clock: keyboardClock,
                tap: {
                    try catchingObjCException {
                        print(
                            "[GesturePerformer] tapAndAwaitKeyboardFocus begin resourceId=\(resourceId) exists=\(element.exists) isHittable=\(element.isHittable) type=\(element.elementType.rawValue)"
                        )
                        element.tap()
                    }
                },
                probe: { try self.detectKeyboardFocus(app: app) }
            )
            let hasFocus = result.hasFocus
            let strategy = result.strategy
            let iterations = result.iterations
            let elapsedMs = result.elapsedMs
            print(
                "[GesturePerformer] tapAndAwaitKeyboardFocus done resourceId=\(resourceId) hasFocus=\(hasFocus) strategy=\(strategy) iterations=\(iterations) elapsedMs=\(elapsedMs)"
            )

            guard hasFocus else {
                let diag = buildFocusDiagnostic(app: app, reason: "tapAndAwaitKeyboardFocus: \(resourceId)")
                print("[GesturePerformer] \(diag)")
                throw GestureError.gestureFailed(
                    "Element '\(resourceId)' did not receive keyboard focus after tap. Diagnostic: \(diag)"
                )
            }
        }

        /// Build a compact diagnostic string enumerating candidate text-entry
        /// elements and their focus state, for #1925-style "no keyboard focus"
        /// failures. Returned as a single line so it fits in a WebSocket error.
        private func buildFocusDiagnostic(app: XCUIApplication, reason: String) -> String {
            catchingObjCExceptionNonThrowing({
                guard let snapshot = try? app.snapshot() else {
                    return "reason=\"\(reason)\" [diagnostic collection failed]"
                }
                let summary = GesturePerformer.boundedFocusDiagnostic(
                    root: snapshot,
                    children: { $0.children },
                    describe: { node in
                        let kind: String
                        switch node.elementType {
                        case .textField: kind = "textFields"
                        case .secureTextField: kind = "secureTextFields"
                        case .textView: kind = "textViews"
                        case .searchField: kind = "searchFields"
                        default: return nil
                        }
                        return FocusDiagnosticEntry(
                            kind: kind,
                            identifier: node.identifier,
                            hasFocus: node.hasFocus,
                            isSelected: node.isSelected,
                            valueLength: (node.value as? String)?.count ?? 0,
                            frame: node.frame
                        )
                    }
                )
                var parts: [String] = []
                parts.append("reason=\"\(reason)\"")
                parts.append("app.label=\"\(snapshot.label)\"")
                parts.append("app.identifier=\"\(snapshot.identifier)\"")

                for name in ["textFields", "secureTextFields", "textViews", "searchFields"] {
                    parts.append("\(name).count=\(summary.counts[name, default: 0])")
                    for (index, entry) in (summary.entries[name] ?? []).enumerated() {
                        let frame = entry.frame
                        parts.append(
                            "\(name)[\(index)]={id=\"\(entry.identifier)\",hasKeyboardFocus=unknown,hasFocus=\(entry.hasFocus),isSelected=\(entry.isSelected),isHittable=unknown,value.len=\(entry.valueLength),frame=\(ElementBounds.clampedInt(frame.origin.x)),\(ElementBounds.clampedInt(frame.origin.y)),\(ElementBounds.clampedInt(frame.size.width)),\(ElementBounds.clampedInt(frame.size.height))}"
                        )
                    }
                }

                // A single app snapshot cannot establish keyboard visibility or
                // SpringBoard state; preserve these diagnostic keys honestly.
                parts.append("app.keyboards.count=unknown")
                parts.append("springboard.keyboards.count=unknown")
                parts.append("snapshot.nodes=\(summary.visitedNodes)")
                parts.append("snapshot.truncated=\(summary.truncated)")
                return parts.joined(separator: " | ")
            }, fallback: "reason=\"\(reason)\" [diagnostic collection failed]")
        }
    }
#endif
