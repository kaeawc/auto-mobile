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
        // MARK: - Actions

        public func performAction(
            _ action: String, resourceId: String? = nil, label: String? = nil,
            bounds: ElementBounds? = nil, duration: Int? = nil
        )
            throws
        {
            if action.caseInsensitiveCompare("system_alert_accept") == .orderedSame {
                try catchingObjCException {
                    // iOS 26.5 can render a SpringBoard confirmation that is
                    // absent even from a fresh SpringBoard snapshot. Query the
                    // live alert/sheet only for this explicit system action.
                    // Select its final button by accessibility order so
                    // localized Open labels do not affect acceptance.
                    guard let button = self.systemAlertAcceptanceButton() else {
                        throw GestureError.elementNotFound("system alert acceptance button")
                    }
                    button.tap()
                }
                return
            }

            let element = actionElement(resourceId: resourceId, label: label, bounds: bounds)
            guard let found = element else {
                throw GestureError.elementNotFound(resourceId ?? label ?? "unknown")
            }

            try catchingObjCException {
                switch action.lowercased() {
                case "click", "tap", "activate":
                    // "activate" is the VoiceOver activation gesture (issue #2857); for an
                    // element located by label it resolves to a tap, matching "click"/"tap".
                    found.tap()
                case "long_click", "long_press":
                    found.press(forDuration: Self.longPressDuration(duration))
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

        private func actionElement(resourceId: String?, label: String?, bounds: ElementBounds?) -> XCUIElement? {
            var element: XCUIElement?
            if let resourceId = resourceId {
                element = elementLocator.findElement(byResourceId: resourceId) as? XCUIElement
            }
            if element == nil, let label = label {
                if let bounds {
                    element = elementLocator.findElement(byText: label, bounds: bounds) as? XCUIElement
                    if element == nil {
                        element = elementLocator.findElement(byText: label) as? XCUIElement
                    }
                } else {
                    element = elementLocator.findElement(byText: label) as? XCUIElement
                }
            }
            return element
        }

        private func systemAlertAcceptanceButton() -> XCUIElement? {
            let systemDialogs = [
                springboard.alerts.firstMatch,
                springboard.sheets.firstMatch,
            ]
            for dialog in systemDialogs {
                guard dialog.exists || dialog.waitForExistence(timeout: 0.5) else {
                    continue
                }
                let buttons = dialog.buttons.allElementsBoundByIndex.filter {
                    $0.exists && $0.isHittable && !$0.frame.isEmpty
                }
                // The custom-URL confirmation has Cancel then the affirmative
                // action. Refuse another system dialog shape rather than
                // guessing which control is safe to activate.
                guard buttons.count == 2 else {
                    continue
                }
                return buttons.last
            }
            return nil
        }

        /// Activates the zero-based case-insensitive matching link within its owner.
        /// Scoped candidates include the owner's link descendants and the owner itself
        /// when it is a link. Without an owner, only occurrence 0 is supported: tap the
        /// first matching hittable app link, since XCUITest exposes no owner grouping.
        public func activateAccessibilityLink(
            text: String,
            occurrence: Int,
            ownerResourceId: String?
        )
            throws
        {
            guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, occurrence >= 0 else {
                throw GestureError.gestureFailed("Semantic link text must be non-blank and occurrence non-negative")
            }
            try Self.validateSemanticLinkFallback(occurrence: occurrence, ownerResourceId: ownerResourceId)
            guard let app = resolveNavigationApp() else {
                throw GestureError.noApplication
            }
            try catchingObjCException {
                let links: [XCUIElement]
                if let ownerResourceId {
                    let owners = app.descendants(matching: .any).allElementsBoundByIndex.filter {
                        $0.identifier == ownerResourceId &&
                            $0.exists &&
                            $0.isHittable &&
                            !$0.frame.isEmpty
                    }
                    guard owners.count == 1 else {
                        throw GestureError.gestureFailed(
                            "Semantic link owner '\(ownerResourceId)' is missing, not actionable, or ambiguous"
                        )
                    }
                    let owner = owners[0]
                    links = Self.scopedLinkCandidates(
                        owner: owner,
                        ownerIsLink: owner.elementType == .link,
                        descendants: owner.descendants(matching: .link).allElementsBoundByIndex
                    )
                } else {
                    links = app.links.allElementsBoundByIndex
                }
                let matches = links.filter {
                    $0.label.caseInsensitiveCompare(text) == .orderedSame &&
                        $0.exists &&
                        $0.isHittable &&
                        !$0.frame.isEmpty
                }
                guard matches.indices.contains(occurrence) else {
                    throw GestureError.elementNotFound("semantic link '\(text)' occurrence \(occurrence)")
                }
                let link = matches[occurrence]
                guard link.exists, link.isHittable, !link.frame.isEmpty else {
                    throw GestureError.gestureFailed(
                        "Semantic link '\(text)' occurrence \(occurrence) is no longer hittable"
                    )
                }
                link.tap()
            }
        }
    }
#endif
