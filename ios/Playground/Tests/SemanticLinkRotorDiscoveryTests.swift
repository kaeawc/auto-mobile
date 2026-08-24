@testable import AutoMobileSDK
import XCTest

#if DEBUG && canImport(UIKit) && !os(watchOS)
    import UIKit

    /// Deterministic coverage for issue #5578: `ViewHierarchyWalker` discovers inline
    /// semantic links exposed through an accessibility element's `.link` system rotor
    /// (how SwiftUI `Text(AttributedString)` inline links surface in-app) and
    /// synthesizes an owner node with per-occurrence text + activation geometry.
    ///
    /// The accessibility structure is built programmatically — an owner element with
    /// a `.link` rotor whose items are distinct link elements — rather than by
    /// rendering live SwiftUI. That keeps the test deterministic and independent of
    /// whether the CI simulator actually renders SwiftUI text + wires its rotor (an
    /// earlier live-render E2E passed on real displays but was flaky on headless CI).
    /// The live behavior itself is verified by manual on-device runs of the Playground
    /// "Semantic Links (SwiftUI)" demo.
    final class SemanticLinkRotorDiscoveryTests: XCTestCase {
        /// A link target vended by the rotor: carries the visible label and its
        /// on-screen frame, exactly like SwiftUI's private `LinkElement`.
        private func linkElement(
            container: UIView,
            label: String,
            frame: CGRect
        )
            -> UIAccessibilityElement
        {
            let element = UIAccessibilityElement(accessibilityContainer: container)
            element.accessibilityLabel = label
            element.accessibilityFrame = frame
            element.accessibilityTraits = .link
            return element
        }

        /// Build an owner accessibility element (a single `staticText` node, as SwiftUI
        /// collapses inline links to) whose `.link` rotor enumerates `links` in order.
        @MainActor
        private func ownerElement(
            container: UIView,
            identifier: String,
            frame: CGRect,
            links: [UIAccessibilityElement]
        )
            -> UIAccessibilityElement
        {
            let owner = UIAccessibilityElement(accessibilityContainer: container)
            owner.accessibilityIdentifier = identifier
            owner
                .accessibilityLabel =
                "Read the Terms of Service, contact Support, or review the Terms of Service again."
            owner.accessibilityFrame = frame
            owner.accessibilityTraits = .staticText
            // A `.link` system rotor that walks `links` in document order: `.next` from
            // an unknown/none item returns the first, then each subsequent element, then
            // nil past the end — matching how the walker enumerates it.
            let rotor = UIAccessibilityCustomRotor(systemType: .link) { predicate in
                let currentTarget = predicate.currentItem.targetElement
                let currentIndex = links.firstIndex { $0 === currentTarget }
                let nextIndex: Int
                if let currentIndex {
                    nextIndex = predicate.searchDirection == .next ? currentIndex + 1 : currentIndex - 1
                } else {
                    nextIndex = predicate.searchDirection == .next ? 0 : links.count - 1
                }
                guard nextIndex >= 0, nextIndex < links.count else { return nil }
                return UIAccessibilityCustomRotorItemResult(targetElement: links[nextIndex], targetRange: nil)
            }
            owner.accessibilityCustomRotors = [rotor]
            return owner
        }

        private func ownerNode(in hierarchy: SdkViewHierarchy, identifier: String) -> SdkViewNode? {
            guard let root = hierarchy.root else { return nil }
            var stack = [root]
            while let node = stack.popLast() {
                if node.accessibilityIdentifier == identifier { return node }
                stack.append(contentsOf: node.children ?? [])
            }
            return nil
        }

        @MainActor
        func testWalkerDiscoversLinkRotorOnOwnerWithOccurrenceAndGeometry() {
            let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 402, height: 874))
            let rootView = UIView(frame: window.bounds)
            window.addSubview(rootView)
            window.isHidden = false

            // Duplicate "Terms of Service" on two different lines (distinct frames), a
            // "Support" link between them — the disambiguation the ACs require.
            let firstTerms = linkElement(
                container: rootView,
                label: "Terms of Service",
                frame: CGRect(x: 93, y: 190, width: 126, height: 21)
            )
            let support = linkElement(
                container: rootView,
                label: "Support",
                frame: CGRect(x: 292, y: 190, width: 59, height: 21)
            )
            let secondTerms = linkElement(
                container: rootView,
                label: "Terms of Service",
                frame: CGRect(x: 105, y: 211, width: 126, height: 21)
            )
            rootView.accessibilityElements = [
                ownerElement(
                    container: rootView,
                    identifier: "swiftui_semantic_links_inline",
                    frame: CGRect(x: 17, y: 190, width: 366, height: 43),
                    links: [firstTerms, support, secondTerms]
                ),
            ]

            let hierarchy = ViewHierarchyWalker.walk(window: window)
            guard let owner = ownerNode(in: hierarchy, identifier: "swiftui_semantic_links_inline") else {
                return XCTFail("Walker did not synthesize an owner node for the link rotor")
            }
            guard let links = owner.semanticLinks else {
                return XCTFail("Owner node carries no semanticLinks")
            }

            // AC1: three links in document order, per-text ascending occurrence.
            XCTAssertEqual(links.map(\.text), ["Terms of Service", "Support", "Terms of Service"])
            XCTAssertEqual(links.map(\.occurrence), [0, 0, 1])
            // Rotor links carry no character range.
            XCTAssertNil(links[0].start)
            XCTAssertNil(links[2].end)

            // AC1 geometry / AC2 input: each link's activation center is the midpoint of
            // its rotor frame (screen == root here; the walker rounds each coordinate),
            // and the duplicate occurrences sit on different lines so a coordinate tap
            // selects the correct one. firstTerms (93,190,126,21) → (156, 201);
            // secondTerms (105,211,126,21) → (168, 222).
            XCTAssertEqual(links[0].centerX, 156)
            XCTAssertEqual(links[0].centerY, 201)
            XCTAssertEqual(links[2].centerX, 168)
            XCTAssertEqual(links[2].centerY, 222)
            if let firstY = links[0].centerY, let secondY = links[2].centerY {
                XCTAssertLessThan(firstY, secondY, "occurrence 0 must sit above occurrence 1")
            }
        }

        @MainActor
        func testElementWithoutLinkRotorYieldsNoSemanticLinks() {
            let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 402, height: 874))
            let rootView = UIView(frame: window.bounds)
            window.addSubview(rootView)
            window.isHidden = false

            let plain = UIAccessibilityElement(accessibilityContainer: rootView)
            plain.accessibilityIdentifier = "plain_text"
            plain.accessibilityLabel = "No links here"
            plain.accessibilityFrame = CGRect(x: 17, y: 190, width: 200, height: 21)
            plain.accessibilityTraits = .staticText
            rootView.accessibilityElements = [plain]

            let hierarchy = ViewHierarchyWalker.walk(window: window)
            // No `.link` rotor ⇒ no synthesized owner node for it.
            XCTAssertNil(ownerNode(in: hierarchy, identifier: "plain_text")?.semanticLinks)
        }
    }
#endif
