@testable import AutoMobileOverlayAgentCore
import XCTest

#if canImport(AppKit)
    import AppKit
    import SwiftUI

    /// `OverlayLayeredLayout` with a real SwiftUI layout pass on the macOS host (#10899). The
    /// renderer's node wrappers are UIKit-bound; these use the same layout with stand-in rows.
    @MainActor
    final class OverlayLayeredLayoutTests: XCTestCase {
        private final class Probe {
            var frame: CGRect = .zero
        }

        /// A 40×20 leaf that records the width it was last placed with.
        private struct Recorder: Layout {
            let probe: Probe

            func sizeThatFits(proposal _: ProposedViewSize, subviews _: Subviews, cache _: inout ()) -> CGSize {
                CGSize(width: 40, height: 20)
            }

            func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache _: inout ()) {
                probe.frame.size.width = proposal.width ?? -1
                subviews.forEach { $0.place(at: bounds.origin, proposal: .init(bounds.size)) }
            }
        }

        private enum Wrapper {
            case none
            case layered
        }

        private struct Page: View {
            let wrapper: Wrapper
            let probe: Probe

            var body: some View {
                VStack(alignment: .leading) {
                    switch wrapper {
                    case .none: Recorder(probe: probe) { Color.clear }
                    case .layered: OverlayLayeredLayout(alignment: .topLeading) {
                            Recorder(probe: probe) { Color.clear }
                        }
                    }
                }
                .frame(width: 300, alignment: .topLeading)
            }
        }

        private func layOut(_ view: some View) -> NSHostingView<some View> {
            let host = NSHostingView(rootView: view)
            host.frame = NSRect(origin: .zero, size: host.fittingSize)
            host.layoutSubtreeIfNeeded()
            return host
        }

        private func placedWidth(_ wrapper: Wrapper) -> CGFloat {
            let probe = Probe()
            _ = layOut(Page(wrapper: wrapper, probe: probe))
            return probe.frame.width
        }

        func testTheLayeredLayoutPlacesTheChildWithItsParentsProposal() {
            // Not at the 40 pt it measured: an HStack placed at exactly its ideal width shares it
            // evenly, which cut "Edit"/"Save" short in material-controls (#10899). Unwrapped, the
            // VStack makes the same placement.
            XCTAssertEqual(placedWidth(.none), 300)
            XCTAssertEqual(placedWidth(.layered), 300)
        }

        func testAFillingAxisIsGreedyInsideAStack() {
            let probe = Probe()
            _ = layOut(
                VStack(spacing: 0) {
                    OverlayLayeredLayout(fillsHeight: true, alignment: .center) {
                        Color.clear.frame(width: 40, height: 20)
                    }
                    .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { probe.frame = $0 }
                    Color.clear.frame(height: 10)
                }
                .frame(width: 300, height: 100)
            )
            // A filling node is greedy inside a stack, as with `frame(maxHeight: .infinity)`.
            XCTAssertEqual(probe.frame.size, CGSize(width: 40, height: 90))
        }

        func testChildrenLayerToTheLargestAndAlign() {
            let probe = Probe()
            let host = layOut(
                OverlayLayeredLayout(alignment: .bottomTrailing) {
                    Color.clear.frame(width: 100, height: 60)
                    Color.clear.frame(width: 20, height: 10)
                        .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { probe.frame = $0 }
                }
            )
            XCTAssertEqual(host.fittingSize, CGSize(width: 100, height: 60))
            XCTAssertEqual(probe.frame, CGRect(x: 80, y: 50, width: 20, height: 10))
        }
    }
#endif
