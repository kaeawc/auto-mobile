import Foundation

// MARK: - Structural Hasher

/// Computes a structural hash of a `ViewHierarchy` for change detection.
/// Ignores bounds to focus on content changes vs. animation changes.
///
/// Ported verbatim from the reference target. The result is an `Int` from Swift's
/// per-process-seeded `Hasher`, used ONLY to gate broadcasts (same hash = skip);
/// it is never serialized onto the wire, so its absolute value need not be stable
/// across runs — only "same input → same hash within a process".
public enum StructuralHasher {
    /// Compute a structural hash of the hierarchy.
    /// Ignores bounds to differentiate content changes from animation/scroll changes.
    public static func computeHash(_ hierarchy: ViewHierarchy) -> Int {
        var hasher = Hasher()

        // Include package name
        if let packageName = hierarchy.packageName {
            hasher.combine(packageName)
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
