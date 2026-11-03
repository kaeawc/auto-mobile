#if DEBUG && !os(watchOS)
    import Foundation

    struct SdkAccessibilityFocusSelector: Decodable {
        var resourceId: String?
        var text: String?
        var contentDesc: String?

        var isValid: Bool {
            [resourceId, text, contentDesc].contains { !($0 ?? "").isEmpty }
        }

        func matches(identifier: String?, label: String?, value: String?) -> Bool {
            if let resourceId, !resourceId.isEmpty { return identifier == resourceId }
            if let text, !text.isEmpty { return label == text || value == text }
            if let contentDesc, !contentDesc.isEmpty { return label == contentDesc || value == contentDesc }
            return false
        }
    }

    struct SdkAccessibilityFocusResult: Encodable {
        let status: String
        var errorCode: String?
    }

    @MainActor
    protocol AccessibilityFocusElement: AnyObject {
        var focusIdentifier: String? { get }
        var focusLabel: String? { get }
        var focusValue: String? { get }
        var focusEligible: Bool { get }
        var focusChildren: [any AccessibilityFocusElement] { get }
    }

    enum SdkAccessibilityFocus {
        /// The state check precedes validation and traversal: posting with VoiceOver off is a no-op.
        @MainActor
        static func perform(
            selector: SdkAccessibilityFocusSelector,
            voiceOverRunning: Bool,
            roots: () -> [any AccessibilityFocusElement],
            post: (any AccessibilityFocusElement) -> Void
        )
            -> SdkAccessibilityFocusResult
        {
            guard voiceOverRunning else {
                return SdkAccessibilityFocusResult(status: "error", errorCode: "voiceover_off")
            }
            guard selector.isValid else {
                return SdkAccessibilityFocusResult(status: "error", errorCode: "invalid_selector")
            }
            guard let element = firstMatch(selector: selector, roots: roots()) else {
                return SdkAccessibilityFocusResult(status: "error", errorCode: "element_not_found")
            }
            post(element)
            return SdkAccessibilityFocusResult(status: "ok")
        }

        @MainActor
        static func firstMatch(
            selector: SdkAccessibilityFocusSelector,
            roots: [any AccessibilityFocusElement]
        )
            -> (any AccessibilityFocusElement)?
        {
            var pending = Array(roots.reversed())
            var visited = Set<ObjectIdentifier>()
            while let element = pending.popLast() {
                guard visited.insert(ObjectIdentifier(element)).inserted else { continue }
                if element.focusEligible, selector.matches(
                    identifier: element.focusIdentifier, label: element.focusLabel, value: element.focusValue
                ) {
                    return element
                }
                pending.append(contentsOf: element.focusChildren.reversed())
            }
            return nil
        }
    }

    #if canImport(UIKit)
        import UIKit

        extension NSObject: AccessibilityFocusElement {
            var focusIdentifier: String? { ViewHierarchyWalkerMainActor.accessibilityIdentifier(of: self) }
            var focusLabel: String? { accessibilityLabel }
            var focusValue: String? { accessibilityValue }
            var focusEligible: Bool {
                if let view = self as? UIView, view.isHidden || view.alpha <= 0 { return false }
                return isAccessibilityElement
            }

            var focusChildren: [any AccessibilityFocusElement] {
                if let view = self as? UIView {
                    guard !view.isHidden, view.alpha > 0, !view.accessibilityElementsHidden else { return [] }
                    // Walk the same window, subviews and vended accessibility elements as hierarchy observation.
                    return view.subviews + ViewHierarchyWalkerMainActor.accessibilityElements(of: view)
                }
                guard !accessibilityElementsHidden else { return [] }
                return ViewHierarchyWalkerMainActor.accessibilityElements(of: self)
            }
        }

        extension SdkAccessibilityFocus {
            @MainActor
            static func performInApplication(selector: SdkAccessibilityFocusSelector) -> SdkAccessibilityFocusResult {
                perform(
                    selector: selector,
                    voiceOverRunning: UIAccessibility.isVoiceOverRunning,
                    roots: { ViewHierarchyWalkerMainActor.visibleKeyWindow().map { [$0] } ?? [] },
                    post: { UIAccessibility.post(notification: .layoutChanged, argument: $0) }
                )
            }
        }
    #endif
#endif
