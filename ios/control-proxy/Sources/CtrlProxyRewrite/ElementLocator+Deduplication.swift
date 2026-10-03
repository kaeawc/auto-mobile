import Foundation

extension ElementLocator {
    /// Collapse same-type text-input children into their parent.
    ///
    /// iOS UIKit exposes internal subviews (e.g. _UITextFieldRoundedRectBackgroundViewNeue)
    /// as accessibility elements with the *same* elementType as the parent text field.
    /// These are non-interactive noise that confuse element targeting.
    ///
    /// For text-input parent types, any child with the same className that carries no
    /// unique identifying properties is collapsed: its children are absorbed into the
    /// parent's child list, and the duplicate wrapper is removed.
    nonisolated static func collapseSameTypeTextInputChildren(
        parentClassName: String?,
        children: [UIElementInfo]
    )
        -> [UIElementInfo]
    {
        guard let parentClass = parentClassName,
              textInputClassNames.contains(parentClass)
        else {
            return children
        }

        var result: [UIElementInfo] = []
        for child in children {
            if child.className == parentClass, !hasUniqueIdentifyingProperties(child), !hasStateFlags(child) {
                // Collapse: absorb this child's children into the parent level
                if let grandchildren = child.node {
                    result.append(contentsOf: grandchildren)
                }
                // else: empty same-type wrapper — discard entirely
            } else {
                result.append(child)
            }
        }
        return result
    }

    /// Whether the element carries any state flags (focused, selected, checked,
    /// password, clickable, scrollable) that make it semantically distinct.
    private nonisolated static func hasStateFlags(_ element: UIElementInfo) -> Bool {
        return element.focused != nil || element.selected != nil
            || element.checked != nil || element.password != nil
            || element.clickable != nil || element.scrollable != nil
    }

    /// Deduplicate sibling elements that share the same elementType, identical bounds,
    /// and carry no unique identifying properties (no id, text, contentDesc, hintText).
    /// Only deduplicates leaf elements (no children) — elements with distinct subtrees
    /// are always preserved to avoid discarding valid controls.
    /// Keeps only the first occurrence of each duplicate.
    nonisolated static func deduplicateSiblings(_ children: [UIElementInfo]) -> [UIElementInfo] {
        var seen: Set<String> = []
        var result: [UIElementInfo] = []

        for child in children {
            if hasUniqueIdentifyingProperties(child) {
                // Has unique info — always keep
                result.append(child)
                continue
            }

            // Elements with children have distinct subtrees — always keep
            if let node = child.node, !node.isEmpty {
                result.append(child)
                continue
            }

            // Elements with any state flags are considered distinct — don't discard
            // a focused/selected/checked/password element as a duplicate
            if hasStateFlags(child) {
                result.append(child)
                continue
            }

            // Build key from className + bounds
            let key: String
            if let cls = child.className, let b = child.bounds {
                key = "\(cls)|\(b.left),\(b.top),\(b.right),\(b.bottom)"
            } else if let cls = child.className {
                key = "\(cls)|nobounds"
            } else {
                // No className — can't meaningfully dedup, keep it
                result.append(child)
                continue
            }

            if seen.contains(key) {
                continue
            }
            seen.insert(key)
            result.append(child)
        }
        return result
    }

    /// Collapse common XCTest/UIKit hierarchy noise that survives the generic
    /// structural wrapper pass. The rules are intentionally conservative:
    /// discard duplicated labels/scroll bars/accessory nodes only when the node
    /// is non-actionable, while preserving tappable controls, text inputs, ids,
    /// focus/selection state, and meaningful descendants.
    nonisolated static func cleanupXCTestUIKitNoise(
        parent: UIElementInfo,
        children: [UIElementInfo]
    )
        -> [UIElementInfo]
    {
        var seenNoiseKeys: Set<String> = []
        var result: [UIElementInfo] = []

        for child in children {
            if isDuplicateLabel(child, of: parent) {
                continue
            }
            if isStructuralWrapperWithOnlyScrollBarNoise(child) {
                continue
            }
            if let key = dedupeNoiseKey(child) {
                if seenNoiseKeys.contains(key) {
                    continue
                }
                seenNoiseKeys.insert(key)
            }
            result.append(child)
        }

        return result
    }

    private nonisolated static func isDuplicateLabel(_ child: UIElementInfo, of parent: UIElementInfo) -> Bool {
        guard let parentText = parent.text,
              let childText = child.text,
              parentText == childText,
              child.className == "UILabel",
              isActionableContainer(parent),
              !isActionable(child)
        else {
            return false
        }
        return true
    }

    /// Remove unlabeled image/icon artwork anywhere below a labeled, clickable
    /// SpringBoard icon. An identified intermediate view can survive wrapper
    /// promotion, so direct-child cleanup alone cannot reach its descendants.
    nonisolated static func removingUnlabeledIconDescendants(_ element: UIElementInfo) -> UIElementInfo {
        guard element.className == "SBIconView",
              element.clickable == "true",
              element.text?.isEmpty == false
        else {
            return element
        }
        return copying(element, node: stripUnlabeledIconDescendants(element.node))
    }

    private nonisolated static func stripUnlabeledIconDescendants(_ children: [UIElementInfo]?) -> [UIElementInfo]? {
        guard let children else { return nil }
        let retained = children.compactMap { child -> UIElementInfo? in
            let pruned = child.node == nil
                ? child
                : copying(child, node: stripUnlabeledIconDescendants(child.node))
            return isUnlabeledIconSubview(pruned) ? nil : pruned
        }
        return retained.isEmpty ? nil : retained
    }

    /// XCTest maps icon image/title artwork as tappable image or icon snapshots,
    /// although the named enclosing icon is the accessibility target. Geometry
    /// cannot distinguish this artwork: it may extend beyond the icon bounds.
    private nonisolated static func isUnlabeledIconSubview(_ child: UIElementInfo) -> Bool {
        guard child.className == "UIImageView" || child.className == "SBIconView",
              child.text == nil,
              child.value == nil,
              child.contentDesc == nil,
              child.resourceId == nil,
              child.hintText == nil,
              child.semanticLinks?.isEmpty ?? true,
              child.node?.isEmpty ?? true,
              child.longClickable != "true",
              child.focused != "true",
              child.accessibilityFocused != "true",
              child.selected != "true",
              child.checkable != "true",
              child.checked != "true",
              child.scrollable != "true",
              child.testTag == nil,
              child.stateDescription == nil,
              child.errorMessage == nil,
              child.extras?.isEmpty ?? true,
              child.actions?.isEmpty ?? true
        else {
            return false
        }
        return true
    }

    private nonisolated static func isActionableContainer(_ element: UIElementInfo) -> Bool {
        return element.clickable == "true"
            || element.role == "button"
            || element.role == "listitem"
            || element.className == "UIButton"
            || element.className == "UITableViewCell"
            || element.className == "UICollectionViewCell"
    }

    private nonisolated static func isActionable(_ element: UIElementInfo) -> Bool {
        return element.clickable == "true"
            || element.resourceId != nil
            || hasProtectedMetadata(element)
    }

    private nonisolated static func isStructuralWrapperWithOnlyScrollBarNoise(_ element: UIElementInfo) -> Bool {
        guard element.className == "UIView",
              !isActionable(element),
              element.text == nil,
              element.value == nil,
              element.contentDesc == nil,
              element.resourceId == nil,
              element.hintText == nil,
              let children = element.node,
              !children.isEmpty
        else {
            return false
        }
        return containsOnlyUnprotectedScrollBarNoise(children)
    }

    nonisolated static func containsOnlyUnprotectedScrollBarNoise(_ children: [UIElementInfo]) -> Bool {
        return !children.isEmpty && children.allSatisfy { isScrollBarNoise($0) && !isActionable($0) }
    }

    private nonisolated static func dedupeNoiseKey(_ element: UIElementInfo) -> String? {
        guard element.node?.isEmpty ?? true else {
            return nil
        }

        if isScrollBarNoise(element), !isActionable(element) {
            return "\(element.className ?? "")|\(normalizedText(element.text))|\(boundsKey(element.bounds))|\(element.resourceId ?? "")"
        }
        if isKeyboardAccessoryNoise(element), !hasProtectedMetadata(element) {
            return "\(element.className ?? "")|\(normalizedText(element.text))|\(boundsKey(element.bounds))|\(element.resourceId ?? "")"
        }
        return nil
    }

    private nonisolated static func hasProtectedMetadata(_ element: UIElementInfo) -> Bool {
        return element.longClickable == "true"
            || element.focused == "true"
            || element.accessibilityFocused == "true"
            || element.selected == "true"
            || element.checkable == "true"
            || element.checked == "true"
            || element.scrollable == "true"
            || element.testTag != nil
            || hasProtectedRoleMetadata(element)
            || element.stateDescription != nil
            || element.errorMessage != nil
            || element.hintText != nil
            || element.extras?.isEmpty == false
            || element.actions?.isEmpty == false
            || textInputClassNames.contains(element.className ?? "")
    }

    private nonisolated static func hasProtectedRoleMetadata(_ element: UIElementInfo) -> Bool {
        guard let role = element.role else {
            return false
        }
        return role != "text" && role != "button"
    }

    private nonisolated static func isScrollBarNoise(_ element: UIElementInfo) -> Bool {
        return normalizedText(element.text).contains("scroll bar")
    }

    private nonisolated static func isKeyboardAccessoryNoise(_ element: UIElementInfo) -> Bool {
        let text = normalizedText(element.text)
        return text == "dictation" || text == "dictate"
    }

    private nonisolated static func normalizedText(_ text: String?) -> String {
        return text?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
    }

    private nonisolated static func boundsKey(_ bounds: ElementBounds?) -> String {
        guard let bounds = bounds else {
            return "nobounds"
        }
        return "\(bounds.left),\(bounds.top),\(bounds.right),\(bounds.bottom)"
    }
}
