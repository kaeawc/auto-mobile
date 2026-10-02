import Foundation

/// Resolves an inline semantic link to the on-screen point the runner taps to
/// activate it (issue #5560).
///
/// XCUITest can only tap a link that surfaces as its own `.link` element, which
/// fails for duplicate inline links (all report occurrence 0) and for SwiftUI
/// inline links (never surfaced). The in-app SDK, however, walks the real
/// attributed text / link accessibility elements and reports each link's center
/// point; this projects the requested `(owner, text, occurrence)` onto that point
/// so the runner can activate the exact link by coordinate. Pure tree query over
/// the (Sendable) SDK models.
public enum SemanticLinkActivation {
    public struct Coordinate: Equatable, Sendable {
        public let x: Double
        public let y: Double

        public init(x: Double, y: Double) {
            self.x = x
            self.y = y
        }
    }

    public struct Resolution: Equatable, Sendable {
        public let coordinate: Coordinate
        public let ownerNote: String?
    }

    /// The activation point and optional owner note, or `nil` when it cannot be
    /// resolved from the SDK hierarchy (no SDK match, or the matched link has no
    /// geometry) — in which case the caller falls back to the XCUITest path.
    ///
    /// `occurrence` is the zero-based index among case-insensitive matching links
    /// within the owning text element, using the SDK link's own occurrence value.
    /// With `ownerResourceId`, match elements carrying that identifier as before.
    /// Without it, select the first owner carrying matching text in preorder;
    /// never skip to a later owner for a missing occurrence or geometry. Multiple
    /// candidate owners produce a note naming the selected owner and count (#6631).
    /// The XCUITest fallback keeps this per-owner meaning: without an owner it
    /// allows only occurrence 0, since its flat links query has no owner grouping.
    public static func coordinate(
        in hierarchy: SdkViewHierarchy?,
        ownerResourceId: String?,
        text: String,
        occurrence: Int
    )
        -> Resolution?
    {
        guard let root = hierarchy?.root else { return nil }

        if let ownerResourceId {
            for owner in matchingNodes(from: root, where: { $0.accessibilityIdentifier == ownerResourceId }) {
                if let link = owner.semanticLinks?.first(where: {
                    $0.occurrence == occurrence && matches($0.text, text)
                }), let coordinate = coordinate(of: link) {
                    return Resolution(coordinate: coordinate, ownerNote: nil)
                }
            }
            return nil
        }

        let owners = matchingNodes(from: root, where: {
            $0.semanticLinks?.contains(where: { matches($0.text, text) }) == true
        })
        guard let owner = owners.first,
              let link = owner.semanticLinks?.first(where: {
                  $0.occurrence == occurrence && matches($0.text, text)
              }), let coordinate = coordinate(of: link)
        else { return nil }

        let ownerName = owner.accessibilityIdentifier ?? "\(owner.className) (candidate owner 1)"
        let ownerNote = owners.count > 1
            ? "Using owner '\(ownerName)', the first of \(owners.count) candidate owners; "
            + "scope with container/subtext for a specific owner."
            : nil
        return Resolution(coordinate: coordinate, ownerNote: ownerNote)
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
