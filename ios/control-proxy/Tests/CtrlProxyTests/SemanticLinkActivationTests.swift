@testable import CtrlProxy
import XCTest

/// Pure resolution of an inline semantic link to the on-screen point the runner
/// taps to activate it (issue #5560). The coordinate tap itself is XCUITest and
/// verified on-device; this pins the owner/occurrence/geometry selection logic.
final class SemanticLinkActivationTests: XCTestCase {
    private func node(
        _ identifier: String? = nil,
        links: [SdkSemanticLink]? = nil,
        children: [SdkViewNode]? = nil
    )
        -> SdkViewNode
    {
        SdkViewNode(
            className: "UITextView",
            bounds: SdkBounds(left: 0, top: 0, right: 375, bottom: 100),
            accessibilityIdentifier: identifier,
            semanticLinks: links,
            children: children
        )
    }

    private func hierarchy(root: SdkViewNode) -> SdkViewHierarchy {
        SdkViewHierarchy(timestamp: 1, bundleId: "x", screenScale: 3, screenWidth: 375, screenHeight: 812, root: root)
    }

    func testResolvesOwnerScopedOccurrenceToItsCenter() {
        let owner = node("inline", links: [
            SdkSemanticLink(text: "Terms of Service", occurrence: 0, start: 9, end: 25, centerX: 40, centerY: 20),
            SdkSemanticLink(text: "Terms of Service", occurrence: 1, start: 58, end: 74, centerX: 300, centerY: 20),
        ])
        let root = node(children: [owner])

        let first = SemanticLinkActivation.coordinate(
            in: hierarchy(root: root), ownerResourceId: "inline", text: "Terms of Service", occurrence: 0
        )
        let second = SemanticLinkActivation.coordinate(
            in: hierarchy(root: root), ownerResourceId: "inline", text: "Terms of Service", occurrence: 1
        )

        XCTAssertEqual(first, SemanticLinkActivation.Coordinate(x: 40, y: 20))
        XCTAssertEqual(second, SemanticLinkActivation.Coordinate(x: 300, y: 20))
    }

    func testResolvesSwiftUIInlineOccurrenceWithoutRange() {
        // SwiftUI inline links are discovered from the `.link` rotor: they carry a
        // center but no character range (issue #5578). Owner-scoped occurrence must
        // still select the correct duplicate-text link by its distinct center.
        let owner = node("swiftui_semantic_links_inline", links: [
            SdkSemanticLink(text: "Terms of Service", occurrence: 0, centerX: 156, centerY: 201),
            SdkSemanticLink(text: "Support", occurrence: 0, centerX: 321, centerY: 201),
            SdkSemanticLink(text: "Terms of Service", occurrence: 1, centerX: 168, centerY: 222),
        ])
        let root = node(children: [owner])
        let tree = hierarchy(root: root)

        XCTAssertEqual(
            SemanticLinkActivation.coordinate(
                in: tree, ownerResourceId: "swiftui_semantic_links_inline", text: "Terms of Service", occurrence: 0
            ),
            SemanticLinkActivation.Coordinate(x: 156, y: 201)
        )
        XCTAssertEqual(
            SemanticLinkActivation.coordinate(
                in: tree, ownerResourceId: "swiftui_semantic_links_inline", text: "Terms of Service", occurrence: 1
            ),
            SemanticLinkActivation.Coordinate(x: 168, y: 222)
        )
    }

    func testMatchesLinkTextCaseInsensitively() {
        let owner = node("inline", links: [
            SdkSemanticLink(text: "Support", occurrence: 0, centerX: 10, centerY: 10),
        ])
        let coordinate = SemanticLinkActivation.coordinate(
            in: hierarchy(root: node(children: [owner])),
            ownerResourceId: "inline",
            text: "support",
            occurrence: 0
        )
        XCTAssertEqual(coordinate, SemanticLinkActivation.Coordinate(x: 10, y: 10))
    }

    func testWithoutOwnerPicksNthMatchingLinkInDocumentOrder() {
        // Bare `accessibilityLink` path: occurrence indexes matching-text links
        // across the whole tree in document order.
        let a = node("a", links: [SdkSemanticLink(text: "Docs", occurrence: 0, centerX: 1, centerY: 1)])
        let b = node("b", links: [SdkSemanticLink(text: "Docs", occurrence: 0, centerX: 2, centerY: 2)])
        let root = node(children: [a, b])

        XCTAssertEqual(
            SemanticLinkActivation.coordinate(
                in: hierarchy(root: root),
                ownerResourceId: nil,
                text: "Docs",
                occurrence: 0
            ),
            SemanticLinkActivation.Coordinate(x: 1, y: 1)
        )
        XCTAssertEqual(
            SemanticLinkActivation.coordinate(
                in: hierarchy(root: root),
                ownerResourceId: nil,
                text: "Docs",
                occurrence: 1
            ),
            SemanticLinkActivation.Coordinate(x: 2, y: 2)
        )
    }

    func testReturnsNilWhenLinkLacksCenter() {
        let owner = node("inline", links: [SdkSemanticLink(text: "Support", occurrence: 0)])
        XCTAssertNil(SemanticLinkActivation.coordinate(
            in: hierarchy(root: node(children: [owner])),
            ownerResourceId: "inline", text: "Support", occurrence: 0
        ))
    }

    func testReturnsNilWhenOwnerOrLinkMissing() {
        let owner = node("inline", links: [SdkSemanticLink(text: "Support", occurrence: 0, centerX: 1, centerY: 1)])
        let h = hierarchy(root: node(children: [owner]))
        XCTAssertNil(SemanticLinkActivation.coordinate(in: h, ownerResourceId: "other", text: "Support", occurrence: 0))
        XCTAssertNil(SemanticLinkActivation.coordinate(
            in: h,
            ownerResourceId: "inline",
            text: "Support",
            occurrence: 5
        ))
        XCTAssertNil(SemanticLinkActivation.coordinate(
            in: nil,
            ownerResourceId: "inline",
            text: "Support",
            occurrence: 0
        ))
    }
}
