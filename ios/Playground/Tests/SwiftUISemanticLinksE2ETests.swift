@testable import AutoMobileSDK
@testable import Playground
import SwiftUI
import XCTest

#if DEBUG && canImport(UIKit) && !os(watchOS)
    import UIKit

    /// End-to-end coverage for issue #5578 on the Playground host app: render the real
    /// SwiftUI "Semantic Links" demo on the simulator, run the in-app
    /// `ViewHierarchyWalker`, and assert that the owning `swiftui_semantic_links_inline`
    /// text element surfaces its three inline `AttributedString` links with the correct
    /// per-occurrence disambiguation and on-screen activation geometry.
    ///
    /// SwiftUI collapses inline links into a single `staticText` accessibility node
    /// (no readable `attributedText`, no `.link`-trait children), so the UIKit path
    /// from #5560 finds nothing. The links are reachable in-app only through the
    /// element's `.link` system custom rotor — this test pins that discovery.
    final class SwiftUISemanticLinksE2ETests: XCTestCase {
        @MainActor
        private func renderDemoAndWalk() -> SdkViewHierarchy {
            let scene = UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .first
            let window: UIWindow = scene.map { UIWindow(windowScene: $0) } ?? UIWindow(frame: UIScreen.main.bounds)
            let host = UIHostingController(
                rootView: NavigationStack { SwiftUISemanticLinksDemo() }.autoMobileTheme()
            )
            window.rootViewController = host
            window.makeKeyAndVisible()
            host.view.setNeedsLayout()
            host.view.layoutIfNeeded()
            // Walk THIS window explicitly, not the resolved key window: other tests in
            // the suite leave overlay windows up, and on a slow CI runner the global
            // key-window heuristic can pick one of those instead of the demo. SwiftUI
            // also wires the link rotor asynchronously, so spin the runloop until the
            // links appear, up to a generous ceiling.
            var hierarchy = ViewHierarchyWalker.walk(window: window)
            var waited: TimeInterval = 0
            while ownerNode(in: hierarchy)?.semanticLinks?.isEmpty ?? true, waited < 8.0 {
                RunLoop.current.run(until: Date().addingTimeInterval(0.25))
                host.view.layoutIfNeeded()
                hierarchy = ViewHierarchyWalker.walk(window: window)
                waited += 0.25
            }
            return hierarchy
        }

        private func ownerNode(in hierarchy: SdkViewHierarchy) -> SdkViewNode? {
            guard let root = hierarchy.root else { return nil }
            var stack = [root]
            while let node = stack.popLast() {
                if node.accessibilityIdentifier == "swiftui_semantic_links_inline",
                   node.semanticLinks?.isEmpty == false
                {
                    return node
                }
                stack.append(contentsOf: node.children ?? [])
            }
            // Fall back to any node with the identifier even without links, for diagnostics.
            stack = [root]
            while let node = stack.popLast() {
                if node.accessibilityIdentifier == "swiftui_semantic_links_inline" { return node }
                stack.append(contentsOf: node.children ?? [])
            }
            return nil
        }

        /// (total nodes, nodes carrying any semanticLinks) — surfaced on failure so a
        /// CI-only miss is diagnosable without a rerun.
        private func nodeStats(in hierarchy: SdkViewHierarchy) -> (total: Int, withLinks: Int) {
            guard let root = hierarchy.root else { return (0, 0) }
            var total = 0
            var withLinks = 0
            var stack = [root]
            while let node = stack.popLast() {
                total += 1
                if node.semanticLinks?.isEmpty == false { withLinks += 1 }
                stack.append(contentsOf: node.children ?? [])
            }
            return (total, withLinks)
        }

        @MainActor
        func testDiscoversSwiftUIInlineLinksOnOwnerWithOccurrenceAndGeometry() {
            let hierarchy = renderDemoAndWalk()
            guard let owner = ownerNode(in: hierarchy) else {
                let (total, withLinks) = nodeStats(in: hierarchy)
                return XCTFail(
                    "No node carrying accessibilityIdentifier swiftui_semantic_links_inline "
                        + "(walked \(total) nodes, \(withLinks) with semanticLinks)"
                )
            }
            guard let links = owner.semanticLinks else {
                return XCTFail("Owner element carries no semanticLinks (SwiftUI inline links undiscovered)")
            }

            // AC1: three inline links in document order with per-text ascending occurrence.
            XCTAssertEqual(links.map(\.text), [
                "Terms of Service", "Support", "Terms of Service",
            ])
            XCTAssertEqual(links.map(\.occurrence), [0, 0, 1])

            // Every link has finite on-screen activation geometry (AC1 geometry / AC2 input).
            for link in links {
                guard let x = link.centerX, let y = link.centerY else {
                    return XCTFail("Link \(link.text)#\(link.occurrence) has no center")
                }
                XCTAssertTrue(x.isFinite && y.isFinite)
            }

            // AC1/AC2: duplicate "Terms of Service" is disambiguable — the two occurrences
            // sit on different lines, so their activation points must differ (occurrence 0
            // above occurrence 1). This is exactly what makes `subtext: { occurrence }`
            // select the correct link.
            let terms = links.filter { $0.text == "Terms of Service" }.sorted { $0.occurrence < $1.occurrence }
            XCTAssertEqual(terms.count, 2)
            if terms.count == 2, let firstY = terms[0].centerY, let secondY = terms[1].centerY {
                XCTAssertLessThan(firstY, secondY, "First 'Terms of Service' should sit above the second")
            }
        }
    }
#endif
