import Foundation

/// Resolves an inline semantic link to the on-screen point the runner taps to
/// activate it (issue #5560).
///
/// XCUITest can only tap a link that surfaces as its own `.link` element, which
/// fails for duplicate inline links (all report occurrence 0) and for SwiftUI
/// inline links (never surfaced). The in-app SDK, however, walks the real
/// attributed text / link accessibility elements and reports each link's center
/// point; this projects the requested `(owner, text, occurrence)` onto that
/// point so the runner can activate the exact link by coordinate.
public enum SemanticLinkActivation {
    public struct Coordinate: Equatable, Sendable {
        public let x: Double
        public let y: Double

        public init(x: Double, y: Double) {
            self.x = x
            self.y = y
        }
    }

    /// The activation point for the requested link, or `nil` when it cannot be
    /// resolved from the SDK hierarchy (no SDK match, or the matched link has no
    /// geometry) — in which case the caller falls back to the XCUITest path.
    ///
    /// - With `ownerResourceId`: match within elements carrying that identifier,
    ///   using the link's own per-owner `occurrence`.
    /// - Without an owner: index the `occurrence`-th matching-text link across the
    ///   whole tree in document order.
    public static func coordinate(
        in hierarchy: SdkViewHierarchy?,
        ownerResourceId: String?,
        text: String,
        occurrence: Int
    )
        -> Coordinate?
    {
        guard let root = hierarchy?.root else { return nil }

        if let ownerResourceId {
            for owner in matchingNodes(from: root, where: { $0.accessibilityIdentifier == ownerResourceId }) {
                if let link = owner.semanticLinks?.first(where: {
                    $0.occurrence == occurrence && matches($0.text, text)
                }), let coordinate = coordinate(of: link) {
                    return coordinate
                }
            }
            return nil
        }

        var matchIndex = 0
        for node in preorder(root) {
            for link in node.semanticLinks ?? [] where matches(link.text, text) {
                if matchIndex == occurrence {
                    return coordinate(of: link)
                }
                matchIndex += 1
            }
        }
        return nil
    }

    private static func matches(_ lhs: String, _ rhs: String) -> Bool {
        lhs.caseInsensitiveCompare(rhs) == .orderedSame
    }

    private static func coordinate(of link: SdkSemanticLink) -> Coordinate? {
        guard let x = link.centerX, let y = link.centerY else { return nil }
        return Coordinate(x: x, y: y)
    }

    private static func matchingNodes(
        from root: SdkViewNode,
        where predicate: (SdkViewNode) -> Bool
    )
        -> [SdkViewNode]
    {
        preorder(root).filter(predicate)
    }

    /// Depth-first, parent-before-children traversal so "document order" matches
    /// the visual reading order of the merged hierarchy.
    private static func preorder(_ root: SdkViewNode) -> [SdkViewNode] {
        var out: [SdkViewNode] = []
        var stack: [SdkViewNode] = [root]
        while let node = stack.popLast() {
            out.append(node)
            if let children = node.children {
                stack.append(contentsOf: children.reversed())
            }
        }
        return out
    }
}
