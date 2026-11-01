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
            var proposals: [ProposedViewSize] = []
            var sizes: [String: CGSize] = [:]
        }

        private func probe(_ name: String, _ frames: Frames, width: CGFloat, height: CGFloat) -> some View {
            Color.clear.frame(width: width, height: height)
                .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { frames.byName[name] = $0 }
        }

        private func flexible(_ name: String, _ frames: Frames) -> some View {
            Color.clear
                .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { frames.byName[name] = $0 }
        }

        private struct IdealProbe: Layout {
            let width: CGFloat
            var wraps = false
            var recording: Frames?

            func sizeThatFits(proposal: ProposedViewSize, subviews _: Subviews, cache _: inout ()) -> CGSize {
                recording?.proposals.append(proposal)
                let fitted = min(width, proposal.width ?? width)
                return CGSize(width: fitted, height: wraps ? ceil(width / max(fitted, 1)) * 40 : 10)
            }

            func placeSubviews(in bounds: CGRect, proposal _: ProposedViewSize, subviews: Subviews, cache _: inout ()) {
                for child in subviews {
                    child.place(at: bounds.origin, anchor: .topLeading, proposal: ProposedViewSize(bounds.size))
                }
            }
        }

        private func ideal(_ name: String, _ frames: Frames, width: CGFloat, wraps: Bool = false) -> some View {
            IdealProbe(width: width, wraps: wraps) { Color.clear }
                .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { frames.byName[name] = $0 }
        }

        private struct UnboundedWrapper: Layout {
            let row = PrototypeRowLayout(spacing: 0)

            func makeCache(subviews: Subviews) -> PrototypeRowLayout.Cache { row.makeCache(subviews: subviews) }

            func sizeThatFits(
                proposal: ProposedViewSize, subviews: Subviews, cache: inout PrototypeRowLayout.Cache
            )
                -> CGSize
            {
                row.sizeThatFits(
                    proposal: ProposedViewSize(width: nil, height: proposal.height), subviews: subviews, cache: &cache
                )
            }

            func placeSubviews(
                in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout PrototypeRowLayout.Cache
            ) {
                row.placeSubviews(
                    in: bounds, proposal: ProposedViewSize(width: bounds.width, height: proposal.height),
                    subviews: subviews, cache: &cache
                )
            }
        }

        private struct ProbeUnboundedSizes: Layout {
            let axis: PrototypeAxis
            let recording: Frames

            func sizeThatFits(proposal _: ProposedViewSize, subviews: Subviews, cache _: inout ()) -> CGSize {
                let ideal = subviews.first?.sizeThatFits(.unspecified) ?? .zero
                let infinite = subviews.first?.sizeThatFits(
                    ProposedViewSize(
                        width: axis == .horizontal ? .infinity : nil,
                        height: axis == .vertical ? .infinity : nil
                    )
                ) ?? .zero
                recording.sizes["ideal"] = ideal
                recording.sizes["infinite"] = infinite
                return ideal
            }

            func placeSubviews(in bounds: CGRect, proposal _: ProposedViewSize, subviews: Subviews, cache _: inout ()) {
                subviews.first?.place(at: bounds.origin, anchor: .topLeading, proposal: ProposedViewSize(bounds.size))
            }
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

        func testNestedControlRowKeepsItsReservationAndWrapsText() throws {
            let frames = Frames()
            let avatar = try rules(#"{"width":{"dp":44},"aspectRatio":1}"#)
            layOut(
                PrototypeWeightedStackLayout(axis: .horizontal, spacing: 12) {
                    ideal("text", frames, width: 286, wraps: true)
                    flexible("spacer", frames).layoutValue(key: PrototypeWeightKey.self, value: 1)
                    PrototypeRowLayout(spacing: 8) {
                        probe("icon", frames, width: 44, height: 44)
                        PrototypeSizedLayout(rules: avatar, alignment: .center) {
                            flexible("avatar", frames)
                        }
                    }
                    .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: {
                        frames.byName["controls"] = $0
                    }
                }.frame(width: 342, alignment: .leading)
            )
            let text = try XCTUnwrap(frames.byName["text"])
            let controls = try XCTUnwrap(frames.byName["controls"])
            let icon = try XCTUnwrap(frames.byName["icon"])
            let avatarFrame = try XCTUnwrap(frames.byName["avatar"])
            XCTAssertEqual(controls.width, 96)
            XCTAssertLessThanOrEqual(text.width, 222)
            XCTAssertGreaterThan(text.height, 60)
            XCTAssertEqual(icon.width, 44)
            XCTAssertEqual(avatarFrame.width, 44)
            XCTAssertEqual(avatarFrame.minX - icon.maxX, 8)
            XCTAssertLessThanOrEqual(avatarFrame.maxX, 342)
        }

        func testRowReservesRealSizedAvatarAndMinimumWidthBox() throws {
            for json in [#"{"width":{"dp":40},"aspectRatio":1}"#, #"{"minWidth":44}"#] {
                let frames = Frames()
                let control = try rules(json)
                let expected = CGFloat(control.minWidth ?? 40)
                layOut(
                    PrototypeRowLayout(spacing: 0) {
                        ideal("text", frames, width: 200)
                        PrototypeSizedLayout(rules: control, alignment: .center) {
                            flexible("control", frames)
                        }
                    }.frame(width: 100, alignment: .leading)
                )
                XCTAssertEqual(frames.byName["text"]?.width, 100 - expected)
                XCTAssertEqual(frames.byName["control"]?.width, expected)
                XCTAssertLessThanOrEqual(frames.byName["control"]?.maxX ?? .infinity, 100)
            }
        }

        func testUnboundedSpaceBetweenRowPlacesFillTextAtItsIdealWidth() {
            let frames = Frames()
            let fitting = layOut(
                PrototypeRowLayout(spacing: 0) {
                    ideal("text", frames, width: 40).layoutValue(key: PrototypeRowFillKey.self, value: true)
                    Spacer(minLength: 0).layoutValue(key: PrototypeRowFillKey.self, value: true)
                    ideal("tail", frames, width: 20)
                }.fixedSize(horizontal: true, vertical: false)
            )
            XCTAssertEqual(fitting.width, 60)
            XCTAssertEqual(frames.byName["text"]?.width, 40)
            XCTAssertEqual(frames.byName["tail"]?.minX, 40)
        }

        func testUnboundedRowPlacesUnequalFillChildrenAtTheirIdealWidths() {
            let frames = Frames()
            let fitting = layOut(
                PrototypeRowLayout(spacing: 0) {
                    ideal("a", frames, width: 40).layoutValue(key: PrototypeRowFillKey.self, value: true)
                    ideal("b", frames, width: 20).layoutValue(key: PrototypeRowFillKey.self, value: true)
                }.fixedSize(horizontal: true, vertical: false)
            )
            XCTAssertEqual(fitting.width, 60)
            XCTAssertEqual(frames.byName["a"]?.width, 40)
            XCTAssertEqual(frames.byName["b"]?.width, 20)
            XCTAssertEqual(frames.byName["b"]?.minX, 40)
        }

        func testUnweightedCoverRowWrapsTextAndKeepsControlFramesInsideBounds() {
            let frames = Frames()
            layOut(
                PrototypeRowLayout(spacing: 12) {
                    PrototypeLayeredLayout(alignment: .topLeading) {
                        ideal("text", frames, width: 286, wraps: true)
                    }
                    .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: {
                        frames.byName["text"] = $0
                    }
                    Color.clear.frame(width: 0, height: 0)
                        .layoutValue(key: PrototypeRowFillKey.self, value: true)
                    probe("icon", frames, width: 44, height: 44)
                    probe("avatar", frames, width: 44, height: 44)
                }
                .frame(width: 342, alignment: .leading)
            )
            XCTAssertEqual(frames.byName["text"]?.minX, 0)
            XCTAssertLessThanOrEqual(frames.byName["text"]?.width ?? .infinity, 218)
            XCTAssertGreaterThan(frames.byName["text"]?.height ?? 0, 60)
            XCTAssertEqual(frames.byName["icon"]?.width, 44)
            XCTAssertEqual(frames.byName["avatar"]?.width, 44)
            XCTAssertLessThanOrEqual(frames.byName["avatar"]?.maxX ?? .infinity, 342)
        }

        func testWeightedCoverRowWrapsTextAndKeepsControlFramesInsideBounds() {
            let frames = Frames()
            layOut(
                PrototypeWeightedStackLayout(axis: .horizontal, spacing: 12) {
                    PrototypeLayeredLayout(alignment: .topLeading) {
                        ideal("text", frames, width: 286, wraps: true)
                    }
                    .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: {
                        frames.byName["text"] = $0
                    }
                    flexible("spacer", frames).layoutValue(key: PrototypeWeightKey.self, value: 1)
                    probe("icon", frames, width: 44, height: 44)
                    probe("avatar", frames, width: 44, height: 44)
                }
                .frame(width: 342, alignment: .leading)
            )
            XCTAssertEqual(frames.byName["text"]?.minX, 0)
            XCTAssertLessThanOrEqual(frames.byName["text"]?.width ?? .infinity, 218)
            XCTAssertGreaterThan(frames.byName["text"]?.height ?? 0, 60)
            XCTAssertEqual(
                (frames.byName["text"]?.width ?? 0) + (frames.byName["spacer"]?.width ?? 0),
                218, accuracy: 1
            )
            XCTAssertEqual(frames.byName["icon"]?.width, 44)
            XCTAssertEqual(frames.byName["avatar"]?.width, 44)
            XCTAssertLessThanOrEqual(frames.byName["avatar"]?.maxX ?? .infinity, 342)
        }

        func testUnweightedRowKeepsFittingWidthsAndMirrorsInRTL() {
            for rtl in [false, true] {
                let frames = Frames()
                let size = layOut(
                    PrototypeRowLayout(spacing: 4) {
                        probe("a", frames, width: 40, height: 10)
                        probe("b", frames, width: 70, height: 10)
                    }
                    .environment(\.layoutDirection, rtl ? .rightToLeft : .leftToRight)
                )
                XCTAssertEqual(size, CGSize(width: 114, height: 10))
                XCTAssertEqual(frames.byName["a"]?.minX, rtl ? 74 : 0)
                XCTAssertEqual(frames.byName["b"]?.minX, rtl ? 0 : 44)
            }
        }

        func testUnweightedRowArrangementSpacersFillRemainingWidth() {
            let frames = Frames()
            layOut(
                PrototypeRowLayout(spacing: 0) {
                    probe("a", frames, width: 40, height: 10)
                    Spacer(minLength: 0).layoutValue(key: PrototypeRowFillKey.self, value: true)
                    probe("b", frames, width: 70, height: 10)
                }.frame(width: 200)
            )
            XCTAssertEqual(frames.byName["a"]?.minX, 0)
            XCTAssertEqual(frames.byName["b"]?.minX, 130)
        }

        func testRowSharesGreedyContentWithWeightKeySpacersAndHonorsCaps() throws {
            let capped = try rules(#"{"maxWidth":60}"#)
            let frames = Frames()
            layOut(
                PrototypeRowLayout(spacing: 8) {
                    flexible("control", frames)
                    PrototypeSizedLayout(rules: capped, alignment: .center) { flexible("spacer", frames) }
                        .layoutValue(key: PrototypeWeightKey.self, value: 1)
                    probe("label", frames, width: 40, height: 10)
                }.frame(width: 340, height: 40, alignment: .leading)
            )
            XCTAssertEqual(frames.byName["control"]?.width, 224)
            XCTAssertEqual(frames.byName["spacer"]?.width, 60)
            XCTAssertEqual(frames.byName["label"]?.minX, 300)
        }

        func testWeightKeyArrangementSpacerExpandsOnlyHorizontally() {
            let frames = Frames()
            layOut(
                PrototypeRowLayout(spacing: 0) {
                    probe("a", frames, width: 40, height: 10)
                    Spacer(minLength: 0).layoutValue(key: PrototypeWeightKey.self, value: 1)
                    probe("b", frames, width: 70, height: 10)
                }
                .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: {
                    frames.byName["row"] = $0
                }
                .frame(width: 200, height: 100)
            )
            XCTAssertEqual(frames.byName["b"]?.minX, 130)
            XCTAssertEqual(frames.byName["row"]?.height, 10)
        }

        func testGreedyFrameAndSliderTakeRemainderBesideNaturalPercentageLabel() throws {
            let labelWidth = layOut(Text("50%")).width
            for realSlider in [false, true] {
                let frames = Frames()
                layOut(
                    PrototypeRowLayout(spacing: 8) {
                        Group {
                            if realSlider {
                                Slider(value: .constant(0.5))
                            } else {
                                Text("Track").frame(maxWidth: .infinity)
                            }
                        }
                        .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: {
                            frames.byName["control"] = $0
                        }
                        Text("50%")
                            .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: {
                                frames.byName["label"] = $0
                            }
                    }.frame(width: 340, alignment: .leading)
                )
                let control = try XCTUnwrap(frames.byName["control"])
                let label = try XCTUnwrap(frames.byName["label"])
                XCTAssertEqual(control.width, 340 - 8 - labelWidth, accuracy: 1)
                XCTAssertEqual(label.width, labelWidth, accuracy: 1)
                XCTAssertEqual(label.minX - control.maxX, 8, accuracy: 1)
                XCTAssertEqual(label.maxX, 340, accuracy: 1)
            }
        }

        func testSizedSliderTextFieldAndProgressTakeRemainderBesideNaturalLabel() throws {
            let controls = [
                AnyView(Slider(value: .constant(0.5))),
                AnyView(TextField("Value", text: .constant("50%"))),
                AnyView(ProgressView(value: 0.5).progressViewStyle(.linear)),
            ]
            let labelWidth = layOut(Text("50%")).width
            for (index, control) in controls.enumerated() {
                for json in [#"{"minWidth":120}"#, #"{"maxWidth":200}"#, #"{"aspectRatio":2}"#] {
                    let frames = Frames()
                    let bounds = try rules(json)
                    layOut(
                        PrototypeRowLayout(spacing: 8) {
                            PrototypeSizedLayout(rules: bounds, alignment: .leading) { control }
                                .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: {
                                    frames.byName["control"] = $0
                                }
                            Text("50%")
                                .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: {
                                    frames.byName["label"] = $0
                                }
                        }.frame(width: 340, alignment: .leading)
                    )
                    let measured = try XCTUnwrap(frames.byName["control"])
                    let label = try XCTUnwrap(frames.byName["label"])
                    XCTAssertEqual(
                        measured.width,
                        bounds.maxWidth ?? (332 - labelWidth),
                        accuracy: 1,
                        "\(index): \(json)"
                    )
                    XCTAssertEqual(label.width, labelWidth, accuracy: 1)
                    XCTAssertEqual(label.minX - measured.maxX, 8, accuracy: 1)
                }
            }
        }

        func testNestedRowsAndWeightedRowsPassGreedToTheirParent() throws {
            let weightedRules = try rules(#"{"weight":1}"#, weightedAxis: .horizontal)
            let sliderIdeal = layOut(Slider(value: .constant(0.5))).width
            for weighted in [false, true] {
                let frames = Frames()
                let nested = Group {
                    if weighted {
                        PrototypeWeightedStackLayout(axis: .horizontal, spacing: 8) {
                            PrototypeSizedLayout(rules: weightedRules, alignment: .leading) {
                                flexible("control", frames)
                            }.layoutValue(key: PrototypeWeightKey.self, value: 1)
                            probe("label", frames, width: 40, height: 10)
                        }
                    } else {
                        PrototypeRowLayout(spacing: 8) {
                            Slider(value: .constant(0.5))
                                .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: {
                                    frames.byName["control"] = $0
                                }
                            probe("label", frames, width: 40, height: 10)
                        }
                    }
                }
                layOut(
                    PrototypeRowLayout(spacing: 8) {
                        probe("icon", frames, width: 24, height: 10)
                        nested
                    }.frame(width: 340, alignment: .leading)
                )
                let control = try XCTUnwrap(frames.byName["control"])
                let label = try XCTUnwrap(frames.byName["label"])
                XCTAssertEqual(control.width, 260, accuracy: 1)
                XCTAssertEqual(label.width, 40)
                XCTAssertEqual(label.maxX, 340, accuracy: 1)
                layOut(ProbeUnboundedSizes(axis: .horizontal, recording: frames) { nested })
                XCTAssertEqual(frames.sizes["infinite"]?.width, .infinity)
                XCTAssertEqual(frames.sizes["ideal"]?.width ?? 0, weighted ? 48 : sliderIdeal + 48, accuracy: 1)
            }
        }

        func testInfiniteRowProbeIncludesFillKeysButRigidRowsKeepTheirIdealWidth() {
            for fills in [false, true] {
                let frames = Frames()
                layOut(
                    ProbeUnboundedSizes(axis: .horizontal, recording: frames) {
                        PrototypeRowLayout(spacing: 8) {
                            ideal("fill", frames, width: 40)
                                .layoutValue(key: PrototypeRowFillKey.self, value: fills)
                            ideal("label", frames, width: 20)
                        }
                    }
                )
                XCTAssertEqual(frames.sizes["ideal"]?.width, 68)
                XCTAssertEqual(frames.sizes["infinite"]?.width, fills ? .infinity : 68)
            }
        }

        func testWeightedColumnPassesGreedButKeepsNilProposalIdeal() throws {
            let frames = Frames()
            layOut(
                ProbeUnboundedSizes(axis: .vertical, recording: frames) {
                    PrototypeWeightedStackLayout(axis: .vertical, spacing: 4) {
                        Color.clear.frame(width: 10, height: 20)
                        Color.clear.layoutValue(key: PrototypeWeightKey.self, value: 1)
                    }
                }
            )
            XCTAssertEqual(frames.sizes["infinite"]?.height, .infinity)
            XCTAssertEqual(frames.sizes["ideal"]?.height, 24)
        }

        func testWeightedRowSizesGreedySiblingBeforeOneAndThreeWeights() throws {
            for maximum in [nil, 120.0] {
                let frames = Frames()
                var bounds = try rules(#"{"minWidth":80}"#)
                bounds.maxWidth = maximum
                layOut(
                    PrototypeWeightedStackLayout(axis: .horizontal, spacing: 4) {
                        PrototypeSizedLayout(rules: bounds, alignment: .leading) {
                            Text("Track").frame(maxWidth: .infinity)
                        }
                        .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: {
                            frames.byName["control"] = $0
                        }
                        flexible("one", frames).layoutValue(key: PrototypeWeightKey.self, value: 1)
                        flexible("three", frames).layoutValue(key: PrototypeWeightKey.self, value: 3)
                        probe("label", frames, width: 40, height: 10)
                    }.frame(width: 340, alignment: .leading)
                )
                XCTAssertEqual(frames.byName["control"]?.width, maximum ?? 288)
                XCTAssertEqual(frames.byName["one"]?.width, maximum == nil ? 0 : 42)
                XCTAssertEqual(frames.byName["three"]?.width, maximum == nil ? 0 : 126)
                XCTAssertEqual(frames.byName["label"]?.maxX, 340)
            }
        }

        func testFillMinimumBesideSliderAndOverfullTextNeverOverlapsItsNeighbour() throws {
            let box = try rules(#"{"width":"fill","minWidth":44,"height":{"dp":20}}"#)
            for overfull in [false, true] {
                let frames = Frames()
                layOut(
                    PrototypeRowLayout(spacing: 0) {
                        if overfull {
                            Text("A very long single line title").lineLimit(1)
                                .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: {
                                    frames.byName["content"] = $0
                                }
                        } else {
                            Slider(value: .constant(0.5))
                                .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: {
                                    frames.byName["content"] = $0
                                }
                        }
                        PrototypeSizedLayout(rules: box, alignment: .center) { flexible("box", frames) }
                            .background(Color.red)
                            .layoutValue(key: PrototypeRowFillKey.self, value: true)
                        if overfull { probe("icon", frames, width: 44, height: 44) }
                    }.frame(width: overfull ? 50 : 100, alignment: .leading)
                )
                let content = try XCTUnwrap(frames.byName["content"])
                let box = try XCTUnwrap(frames.byName["box"])
                XCTAssertGreaterThanOrEqual(box.width, 44)
                XCTAssertGreaterThanOrEqual(box.minX, content.maxX)
                if overfull {
                    XCTAssertGreaterThanOrEqual(try XCTUnwrap(frames.byName["icon"]).minX, box.maxX)
                }
            }
        }

        func testCappedFillGivesUnusedShareToSpacerAndReportsUsedWidth() throws {
            let capped = try rules(#"{"width":"fill","maxWidth":40,"height":{"dp":10}}"#)
            let frames = Frames()
            layOut(
                PrototypeRowLayout(spacing: 0) {
                    PrototypeSizedLayout(rules: capped, alignment: .center) { flexible("capped", frames) }
                        .layoutValue(key: PrototypeRowFillKey.self, value: true)
                    flexible("spacer", frames).layoutValue(key: PrototypeRowFillKey.self, value: true)
                }.frame(width: 300)
            )
            XCTAssertEqual(frames.byName["capped"]?.width, 40)
            XCTAssertEqual(frames.byName["spacer"]?.width, 260)
            let onlyCapped = Frames()
            layOut(
                PrototypeRowLayout(spacing: 0) {
                    PrototypeSizedLayout(rules: capped, alignment: .center) { flexible("capped", onlyCapped) }
                        .layoutValue(key: PrototypeRowFillKey.self, value: true)
                }
                .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: {
                    onlyCapped.byName["row"] = $0
                }
                .frame(width: 300, alignment: .leading)
            )
            XCTAssertEqual(onlyCapped.byName["row"]?.width, 40)
        }

        func testWeightedColumnKeepsFixedMinimumsInsteadOfJumpingAtZero() throws {
            let fixed = try rules(#"{"height":{"dp":60},"maxHeight":60}"#)
            for height in [99.5, 100, 100.5] {
                let frames = Frames()
                layOut(
                    PrototypeWeightedStackLayout(axis: .vertical, spacing: 0) {
                        ForEach(0 ..< 3) { index in
                            PrototypeSizedLayout(rules: fixed, alignment: .topLeading) {
                                self.flexible("fixed\(index)", frames)
                            }
                        }
                        flexible("weight", frames).layoutValue(key: PrototypeWeightKey.self, value: 1)
                    }.frame(width: 40, height: height, alignment: .topLeading)
                )
                for index in 0 ..< 3 {
                    XCTAssertEqual(frames.byName["fixed\(index)"]?.height, 60)
                    XCTAssertEqual(
                        (frames.byName["fixed\(index)"]?.minY ?? .infinity)
                            - (frames.byName["fixed0"]?.minY ?? 0),
                        CGFloat(index * 60)
                    )
                }
                XCTAssertEqual(frames.byName["weight"]?.height, 0)
            }
        }

        func testHorizontalScrollLazyHStackPreservesUnequalIdealFillWidthsThroughWrapper() {
            let frames = Frames()
            layOut(
                ScrollView(.horizontal) {
                    LazyHStack(spacing: 0) {
                        PrototypeLayeredLayout(alignment: .topLeading) {
                            PrototypeRowLayout(spacing: 0) {
                                ideal("a", frames, width: 40).layoutValue(key: PrototypeRowFillKey.self, value: true)
                                ideal("b", frames, width: 20).layoutValue(key: PrototypeRowFillKey.self, value: true)
                                Spacer(minLength: 0).layoutValue(key: PrototypeRowFillKey.self, value: true)
                            }
                        }
                    }
                }.frame(width: 100, height: 30)
            )
            XCTAssertEqual(frames.byName["a"]?.width, 40)
            XCTAssertEqual(frames.byName["b"]?.width, 20)
            XCTAssertEqual(frames.byName["b"]?.minX, frames.byName["a"]?.maxX)
        }

        func testRowCacheRefreshesWhenSubviewContentAndCountChange() {
            let frames = Frames()
            func content(_ widths: [CGFloat]) -> some View {
                PrototypeRowLayout(spacing: 0) {
                    ForEach(Array(widths.enumerated()), id: \.offset) { index, width in
                        self.ideal("child\(index)", frames, width: width)
                            .layoutValue(key: PrototypeRowFillKey.self, value: true)
                    }
                }.fixedSize(horizontal: true, vertical: false)
            }
            let host = NSHostingView(rootView: content([40, 20]))
            host.frame = CGRect(origin: .zero, size: host.fittingSize)
            host.layoutSubtreeIfNeeded()
            XCTAssertEqual(frames.byName["child0"]?.width, 40)
            host.rootView = content([60, 10, 30])
            host.frame = CGRect(origin: .zero, size: host.fittingSize)
            host.layoutSubtreeIfNeeded()
            XCTAssertEqual(frames.byName["child0"]?.width, 60)
            XCTAssertEqual(frames.byName["child1"]?.width, 10)
            XCTAssertEqual(frames.byName["child2"]?.width, 30)
        }

        func testUnboundedRowSkipsMinimumProbesAndReusesFramesForBoundedPlacement() {
            let frames = Frames()
            layOut(
                UnboundedWrapper {
                    IdealProbe(width: 40, recording: frames) { Color.clear }
                        .layoutValue(key: PrototypeRowFillKey.self, value: true)
                        .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: {
                            frames.byName["text"] = $0
                        }
                    Spacer(minLength: 0).layoutValue(key: PrototypeRowFillKey.self, value: true)
                }
            )
            XCTAssertEqual(frames.byName["text"]?.width, 40)
            XCTAssertFalse(frames.proposals.contains { $0.width == 0 })
        }

        func testUnweightedRowHonorsButtonPriorityAndWrapsOversizedLabels() {
            let frames = Frames()
            layOut(
                PrototypeRowLayout(spacing: 4) {
                    Text("A much longer sibling")
                        .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: {
                            frames.byName["sibling"] = $0
                        }
                    Text("Save").fixedSize(horizontal: false, vertical: true)
                        .layoutPriority(1)
                        .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: {
                            frames.byName["button"] = $0
                        }
                }.frame(width: 100)
            )
            let labelWidth = layOut(Text("Save").fixedSize()).width
            XCTAssertEqual(frames.byName["button"]?.width ?? 0, labelWidth, accuracy: 1)
            XCTAssertLessThanOrEqual(frames.byName["button"]?.maxX ?? .infinity, 100)

            let wrapped = Frames()
            layOut(
                PrototypeRowLayout(spacing: 0) {
                    Text("Save all of the changes").fixedSize(horizontal: false, vertical: true)
                        .layoutPriority(1)
                        .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: {
                            wrapped.byName["button"] = $0
                        }
                }.frame(width: 60)
            )
            XCTAssertLessThanOrEqual(wrapped.byName["button"]?.width ?? .infinity, 60)
            XCTAssertGreaterThan(wrapped.byName["button"]?.height ?? 0, 30)
        }

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
