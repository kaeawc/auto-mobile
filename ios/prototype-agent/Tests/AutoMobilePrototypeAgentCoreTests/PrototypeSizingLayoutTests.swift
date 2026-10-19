@testable import AutoMobilePrototypeAgentCore
import XCTest

#if canImport(AppKit)
    import AppKit
    import SwiftUI

    /// `PrototypeSizedLayout` and `PrototypeWeightedStackLayout` through a real SwiftUI layout pass
    /// on the macOS host (#11543): the SwiftUI `Layout` types live in the Core target, so they are
    /// hosted in an `NSHostingView` and the placed frames are read back.
    @MainActor
    final class PrototypeSizingLayoutTests: XCTestCase {
        private final class Frames: @unchecked Sendable {
            var byName: [String: CGRect] = [:]
        }

        private func probe(_ name: String, _ frames: Frames, width: CGFloat, height: CGFloat) -> some View {
            Color.clear.frame(width: width, height: height)
                .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { frames.byName[name] = $0 }
        }

        private func flexible(_ name: String, _ frames: Frames) -> some View {
            Color.clear
                .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { frames.byName[name] = $0 }
        }

        @discardableResult
        private func layOut(_ view: some View, size: CGSize? = nil) -> CGSize {
            let host = NSHostingView(rootView: view)
            let fitting = host.fittingSize
            host.frame = NSRect(origin: .zero, size: size ?? fitting)
            host.layoutSubtreeIfNeeded()
            return fitting
        }

        private func rules(_ json: String, weightedAxis: PrototypeAxis? = nil) throws -> PrototypeSizeRules {
            let style = try JSONDecoder().decode(Style.self, from: Data(json.utf8))
            return PrototypeSizeRules(style: style, weightedAxis: weightedAxis)
        }

        // MARK: weighted stack

        private func row(_ frames: Frames, spacing: Double = 0, rtl: Bool = false) -> some View {
            PrototypeWeightedStackLayout(axis: .horizontal, spacing: spacing) {
                probe("a", frames, width: 40, height: 10).layoutValue(key: PrototypeWeightKey.self, value: nil)
                flexible("b", frames).layoutValue(key: PrototypeWeightKey.self, value: 1)
                probe("c", frames, width: 20, height: 20).layoutValue(key: PrototypeWeightKey.self, value: nil)
            }
            .frame(width: 300, height: 100)
            .environment(\.layoutDirection, rtl ? .rightToLeft : .leftToRight)
        }

        func testAWeightedRowSharesTheRemainderAndCentresAcrossTheCrossAxis() {
            let frames = Frames()
            layOut(row(frames, spacing: 10))
            XCTAssertEqual(frames.byName["a"], CGRect(x: 0, y: 45, width: 40, height: 10))
            XCTAssertEqual(frames.byName["b"]?.minX, 50)
            XCTAssertEqual(frames.byName["b"]?.width, 300 - 40 - 20 - 20)
            XCTAssertEqual(frames.byName["c"], CGRect(x: 280, y: 40, width: 20, height: 20))
        }

        func testAWeightedRowMirrorsUnderRightToLeft() {
            let frames = Frames()
            layOut(row(frames, spacing: 10, rtl: true))
            // The first child sits at the right edge, as in an HStack and Android's Row.
            XCTAssertEqual(frames.byName["a"], CGRect(x: 260, y: 45, width: 40, height: 10))
            XCTAssertEqual(frames.byName["c"], CGRect(x: 0, y: 40, width: 20, height: 20))
            XCTAssertEqual(frames.byName["b"]?.maxX, 250)
        }

        private func column(_ frames: Frames, rtl: Bool) -> some View {
            PrototypeWeightedStackLayout(axis: .vertical, spacing: 4) {
                probe("a", frames, width: 40, height: 10).layoutValue(key: PrototypeWeightKey.self, value: nil)
                flexible("b", frames).frame(width: 70).layoutValue(key: PrototypeWeightKey.self, value: 1)
            }
            .frame(width: 300, height: 100, alignment: .topLeading)
            .environment(\.layoutDirection, rtl ? .rightToLeft : .leftToRight)
        }

        func testAWeightedColumnIsLeadingAligned() {
            let frames = Frames()
            layOut(column(frames, rtl: false))
            XCTAssertEqual(frames.byName["a"], CGRect(x: 0, y: 0, width: 40, height: 10))
            XCTAssertEqual(frames.byName["b"], CGRect(x: 0, y: 14, width: 70, height: 86))
        }

        func testAWeightedColumnLeadingFlipsUnderRightToLeft() {
            let frames = Frames()
            layOut(column(frames, rtl: true))
            XCTAssertEqual(frames.byName["a"]?.minX, 260)
            XCTAssertEqual(frames.byName["b"]?.minX, 230)
        }

        func testAWeightedRowFillsAFiniteProposalAndIsIdealUnderNone() {
            let weighted = PrototypeWeightedStackLayout(axis: .horizontal, spacing: 4) {
                Color.clear.frame(width: 10, height: 6)
                Color.clear.frame(width: 7, height: 6).layoutValue(key: PrototypeWeightKey.self, value: 2)
            }
            // Unbounded: nothing to share, so the weight resolves to zero and the gap still counts.
            XCTAssertEqual(layOut(weighted), CGSize(width: 14, height: 6))
            // A finite proposal is filled even though the children measure less.
            XCTAssertEqual(layOut(weighted.frame(width: 200)), CGSize(width: 200, height: 6))
        }

        func testAnUnweightedStackKeepsItsContentSizeWithinAFiniteProposal() {
            let plain = PrototypeWeightedStackLayout(axis: .vertical, spacing: 3) {
                Color.clear.frame(width: 9, height: 10)
                Color.clear.frame(width: 4, height: 10)
            }
            XCTAssertEqual(
                layOut(plain.frame(width: 200, height: 200, alignment: .topLeading)),
                CGSize(width: 200, height: 200)
            )
            XCTAssertEqual(layOut(plain), CGSize(width: 9, height: 23))
        }

        func testAZeroProposalYieldsAZeroMainAxisForWeights() {
            let frames = Frames()
            layOut(
                PrototypeWeightedStackLayout(axis: .horizontal, spacing: 0) {
                    flexible("w", frames).layoutValue(key: PrototypeWeightKey.self, value: 1)
                }
                .frame(width: 0, height: 6)
            )
            XCTAssertEqual(frames.byName["w"]?.width, 0)
        }

        // MARK: sized layout

        private func sized(
            _ json: String,
            alignment: Alignment = .topLeading,
            rtl: Bool = false,
            _ frames: Frames,
            content: CGSize = CGSize(width: 80, height: 20)
        )
            throws -> some View
        {
            try PrototypeSizedLayout(rules: rules(json), alignment: alignment) {
                probe("c", frames, width: content.width, height: content.height)
            }
            .environment(\.layoutDirection, rtl ? .rightToLeft : .leftToRight)
        }

        func testAMinWidthCentresWrappedContentLikeAndroidsWrapContentWidth() throws {
            let frames = Frames()
            let size = try layOut(sized(#"{"minWidth": 200}"#, frames))
            XCTAssertEqual(size, CGSize(width: 200, height: 20))
            XCTAssertEqual(frames.byName["c"], CGRect(x: 60, y: 0, width: 80, height: 20))
        }

        func testAMinHeightCentresWrappedContentVertically() throws {
            let frames = Frames()
            let size = try layOut(sized(#"{"minHeight": 60}"#, frames))
            XCTAssertEqual(size, CGSize(width: 80, height: 60))
            XCTAssertEqual(frames.byName["c"], CGRect(x: 0, y: 20, width: 80, height: 20))
        }

        func testAnExplicitWidthKeepsTheContentAlignment() throws {
            let frames = Frames()
            try layOut(sized(#"{"width": {"dp": 200}}"#, frames))
            XCTAssertEqual(frames.byName["c"]?.minX, 0)
            let trailing = Frames()
            // The explicit width keeps the trailing alignment; the unset height wraps and centres.
            try layOut(sized(#"{"width": {"dp": 200}, "minHeight": 60}"#, alignment: .bottomTrailing, trailing))
            XCTAssertEqual(trailing.byName["c"], CGRect(x: 120, y: 20, width: 80, height: 20))
        }

        func testAWrapWidthCentresLikeAnUnsetOne() throws {
            let frames = Frames()
            try layOut(sized(#"{"width": "wrap", "minWidth": 200}"#, frames))
            XCTAssertEqual(frames.byName["c"]?.minX, 60)
        }

        func testASizedLayoutRespectsMaxAgainstAnInfiniteProposal() throws {
            let frames = Frames()
            let size = try layOut(sized(#"{"maxWidth": 50}"#, frames, content: CGSize(width: 80, height: 20)))
            XCTAssertEqual(size.width, 50)
        }

        func testAZeroProposalCollapsesAMinBoundToZero() throws {
            let frames = Frames()
            let size = try layOut(sized(#"{"minWidth": 200}"#, frames).frame(width: 0, height: 0))
            XCTAssertEqual(size, .zero)
        }
    }
#endif
