import Foundation

// MARK: - Structural Hasher

public enum StructuralHasher {
    /// Compute a structural hash of the hierarchy.
    /// Ignores bounds to differentiate content changes from animation/scroll changes.
    public static func computeHash(_ hierarchy: ViewHierarchy) -> Int {
        var hasher = Hasher()

        // Include package name
        if let packageName = hierarchy.packageName {
            hasher.combine(packageName)
        }

        // Completeness changes must broadcast even when the retained nodes are unchanged.
        if let reasons = hierarchy.truncationReasons {
            hasher.combine(reasons)
        }

        // Include hierarchy structure (but not bounds)
        if let root = hierarchy.hierarchy {
            hashElement(root, into: &hasher, depth: 0, maxDepth: 15)
        }

        return hasher.finalize()
    }

    private static func hashElement(_ element: UIElementInfo, into hasher: inout Hasher, depth: Int, maxDepth: Int) {
        // Hash all identifying & state properties (NOT bounds/textSize - those change during animations)
        hasher.combine(element.text)
        hasher.combine(element.contentDesc)
        hasher.combine(element.resourceId)
        hasher.combine(element.className)
        hasher.combine(element.role)
        hasher.combine(element.testTag)
        hasher.combine(element.hintText)
        hasher.combine(element.stateDescription)
        hasher.combine(element.errorMessage)

        // Hash interactive/state properties
        hasher.combine(element.clickable)
        hasher.combine(element.enabled)
        hasher.combine(element.focusable)
        hasher.combine(element.focused)
        hasher.combine(element.accessibilityFocused)
        hasher.combine(element.scrollable)
        hasher.combine(element.password)
        hasher.combine(element.checkable)
        hasher.combine(element.checked)
        hasher.combine(element.selected)
        hasher.combine(element.longClickable)

        // Hash available actions
        if let actions = element.actions {
            hasher.combine(actions)
        }

        // Hash children recursively (up to maxDepth)
        if depth < maxDepth, let children = element.node {
            hasher.combine(children.count)
            for child in children {
                hashElement(child, into: &hasher, depth: depth + 1, maxDepth: maxDepth)
            }
        }
    }
}
