@testable import AutoMobilePrototypeAgentCore
import XCTest

/// `weight`, `minWidth`/`maxWidth`/`minHeight`/`maxHeight` and `aspectRatio` (#11543), asserted on the
/// resolved sizes (`PrototypeSizing`, `PrototypeWeightedStack`) against Android's Compose order of
/// operations, with no layout pass.
final class PrototypeSizingTests: XCTestCase {
    private func style(_ json: String) throws -> Style {
        try JSONDecoder().decode(Style.self, from: Data(json.utf8))
    }

    private func rules(
        _ json: String,
        weightedAxis: PrototypeAxis? = nil,
        coverSize: (width: Double, height: Double)? = nil
    )
        throws -> PrototypeSizeRules
    {
        try PrototypeSizeRules(style: style(json), coverSize: coverSize, weightedAxis: weightedAxis)
    }

    /// A node that would wrap to `content`, under room `width` x `height`.
    private func size(
        _ rules: PrototypeSizeRules,
        in room: (width: Double?, height: Double?),
        content: (width: Double, height: Double) = (30, 10)
    )
        -> PrototypeSizing.Size
    {
        PrototypeSizing.resolve(rules, proposed: room) { maxWidth, maxHeight in
            (min(content.width, maxWidth ?? .infinity), min(content.height, maxHeight ?? .infinity))
        }
    }

    func testFullscreenRootDefaultsEachMissingAxisToFill() throws {
        let implicit = PrototypeSizeRules(style: nil, rootPlacementType: "fullscreen")
        XCTAssertEqual(implicit.width, .fill)
        XCTAssertEqual(implicit.height, .fill)
        XCTAssertEqual(size(implicit, in: (400, 600)).width, 400)
        XCTAssertEqual(size(implicit, in: (400, 600)).height, 600)

        // Reuse the existing sizing inputs; explicit fixed and wrap sizes still win per axis.
        var fixedWidth = try rules(#"{"width":{"dp":117}}"#)
        fixedWidth.height = .fill
        let widthStyle = try style(#"{"width":{"dp":117}}"#)
        let width = PrototypeSizeRules(style: widthStyle, rootPlacementType: "fullscreen")
        XCTAssertEqual(width, fixedWidth)
        XCTAssertEqual(size(width, in: (400, 600)).width, 117)
        XCTAssertEqual(size(width, in: (400, 600)).height, 600)
        let height = try PrototypeSizeRules(
            style: style(#"{"height":{"dp":49}}"#), rootPlacementType: "fullscreen"
        )
        XCTAssertEqual(height.width, .fill)
        XCTAssertEqual(height.height, .points(49))
        let wrap = try PrototypeSizeRules(
            style: style(#"{"width":"wrap","height":"wrap"}"#), rootPlacementType: "fullscreen"
        )
        XCTAssertEqual(size(wrap, in: (400, 600)).width, 30)
        XCTAssertEqual(size(wrap, in: (400, 600)).height, 10)
        for placement in ["floating", "sheet"] {
            let unchanged = PrototypeSizeRules(style: nil, rootPlacementType: placement)
            XCTAssertEqual(unchanged, PrototypeSizeRules(style: nil))
            XCTAssertEqual(size(unchanged, in: (400, 600)).width, 30)
            XCTAssertEqual(size(unchanged, in: (400, 600)).height, 10)
        }
    }

    // MARK: decoding

    func testTheSharedFixtureDecodesEveryNewField() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test/fixtures/prototype-spec/valid/row-weight-size-bounds.json")
        let spec = try JSONDecoder().decode(PrototypeSpec.self, from: Data(contentsOf: url))
        let row = try XCTUnwrap(spec.root.style)
        XCTAssertEqual(row.minHeight, 44)
        XCTAssertEqual(row.maxHeight, 96)
        let content = try XCTUnwrap(spec.root.children?[0].style)
        XCTAssertEqual(content.weight, 1)
        XCTAssertEqual(content.minWidth, 48)
        let control = try XCTUnwrap(spec.root.children?[1].style)
        XCTAssertEqual(control.weight, 0.5)
        XCTAssertEqual(control.maxWidth, 120.5)
    }

    func testAspectRatioDecodesAndStyleWhenOverridesPerField() throws {
        let base = try style(#"{"aspectRatio":1.5,"minWidth":10,"weight":2}"#)
        let merged = try base.merged(with: style(#"{"minWidth":20,"maxHeight":9}"#))
        XCTAssertEqual(merged.aspectRatio, 1.5)
        XCTAssertEqual(merged.weight, 2)
        XCTAssertEqual(merged.minWidth, 20)
        XCTAssertEqual(merged.maxHeight, 9)
    }

    // MARK: bounds clamp width and height

    func testFillIsClampedByMaxAndMin() throws {
        let capped = try rules(#"{"width":"fill","maxWidth":120}"#)
        XCTAssertEqual(size(capped, in: (300, 50)).width, 120)
        XCTAssertEqual(size(capped, in: (80, 50)).width, 80)
        let floored = try rules(#"{"width":"fill","minWidth":120}"#)
        XCTAssertEqual(size(floored, in: (80, 50)).width, 80, "a floor never exceeds the room offered")
    }

    func testFixedSizeIsCoercedIntoTheBounds() throws {
        XCTAssertEqual(try size(rules(#"{"width":{"dp":200},"maxWidth":120}"#), in: (300, 50)).width, 120)
        XCTAssertEqual(try size(rules(#"{"height":{"dp":10},"minHeight":40}"#), in: (300, 50)).height, 40)
        XCTAssertEqual(try size(rules(#"{"width":{"dp":60},"minWidth":40,"maxWidth":120}"#), in: (300, 50)).width, 60)
    }

    func testWrappedContentIsClampedByTheBounds() throws {
        let bounded = try rules(#"{"minWidth":50,"maxHeight":6}"#)
        let resolved = size(bounded, in: (300, 50), content: (30, 10))
        XCTAssertEqual(resolved.width, 50)
        XCTAssertEqual(resolved.height, 6)
    }

    func testMinBeatsMaxWhenTheyCross() throws {
        XCTAssertEqual(try size(rules(#"{"width":"fill","minWidth":100,"maxWidth":40}"#), in: (300, 50)).width, 100)
    }

    func testBoundsOnAnUnboundedAxisStillApply() throws {
        let resolved = try size(rules(#"{"width":"fill","maxWidth":90}"#), in: (nil, nil), content: (200, 10))
        XCTAssertEqual(resolved.width, 90, "fill with no room offered takes the bound it has")
    }

    // MARK: aspect ratio

    func testAspectRatioTakesTheOfferedWidthWhenNothingElseIsFixed() throws {
        let resolved = try size(rules(#"{"aspectRatio":2}"#), in: (200, 500))
        XCTAssertEqual(resolved.width, 200)
        XCTAssertEqual(resolved.height, 100)
    }

    func testAspectRatioFollowsAFixedWidthOrHeight() throws {
        let byWidth = try size(rules(#"{"width":{"dp":80},"aspectRatio":2}"#), in: (200, 500))
        XCTAssertEqual(byWidth.height, 40)
        let byHeight = try size(rules(#"{"height":{"dp":50},"aspectRatio":2}"#), in: (200, 500))
        XCTAssertEqual(byHeight.width, 100)
        XCTAssertEqual(byHeight.height, 50)
    }

    func testAspectRatioIsAppliedAfterTheBounds() throws {
        let resolved = try size(rules(#"{"width":"fill","maxWidth":120,"aspectRatio":4}"#), in: (300, 500))
        XCTAssertEqual(resolved.width, 120)
        XCTAssertEqual(resolved.height, 30)
    }

    func testAspectRatioFallsBackToTheHeightWhenTheWidthWouldOverflowIt() throws {
        let resolved = try size(rules(#"{"aspectRatio":0.5}"#), in: (200, 60))
        XCTAssertEqual(resolved.height, 60)
        XCTAssertEqual(resolved.width, 30)
    }

    func testAspectRatioWithNoRoomLetsTheContentDecide() throws {
        let resolved = try size(rules(#"{"aspectRatio":2}"#), in: (nil, nil), content: (30, 10))
        XCTAssertEqual(resolved.width, 30)
        XCTAssertEqual(resolved.height, 10)
    }

    // MARK: weight

    func testAWeightedNodeTakesExactlyItsShareOverItsOwnSizeAndBounds() throws {
        let weighted = try rules(
            #"{"weight":1,"width":{"dp":10},"minWidth":5,"maxWidth":20,"height":{"dp":8}}"#,
            weightedAxis: .horizontal
        )
        let resolved = size(weighted, in: (140, 50))
        XCTAssertEqual(resolved.width, 140, "the share wins over width and min/max on the main axis")
        XCTAssertEqual(resolved.height, 8, "the cross axis is the node's own")
    }

    func testAWeightOutsideARowOrColumnIsIgnored() throws {
        let loose = try rules(#"{"weight":3,"width":{"dp":10}}"#, weightedAxis: nil)
        XCTAssertNil(loose.weightedAxis)
        XCTAssertEqual(size(loose, in: (140, 50)).width, 10)
    }

    func testTheWeightedShareIsSplitByWeightAfterTheUnweightedChildren() {
        let sizes = PrototypeWeightedStack.mainSizes(
            available: 340,
            spacing: 10,
            weights: [nil, 1, 3]
        ) { _, _ in 60 }
        // 340 - 60 (fixed) - 20 (two gaps) = 260, shared 1:3.
        XCTAssertEqual(sizes, [60, 65, 195])
    }

    func testUnweightedChildrenAreOfferedWhatEarlierSiblingsLeft() {
        var offers: [Double?] = []
        _ = PrototypeWeightedStack.mainSizes(available: 100, spacing: 0, weights: [nil, nil, 1]) { _, most in
            offers.append(most)
            return 70
        }
        XCTAssertEqual(offers, [100, 30])
    }

    func testOverflowingFixedChildrenLeaveWeightedOnesZero() {
        let sizes = PrototypeWeightedStack.mainSizes(available: 50, spacing: 0, weights: [nil, 2]) { _, _ in 80 }
        XCTAssertEqual(sizes, [80, 0])
    }

    func testAWeightOnAnUnboundedAxisHasNoSpaceToShare() {
        let sizes = PrototypeWeightedStack.mainSizes(available: nil, spacing: 4, weights: [nil, 1]) { _, _ in 25 }
        XCTAssertEqual(sizes, [25, 0])
    }

    // MARK: cover anchors and the plain path

    func testACoverAnchorReplacesTheAuthoredSizing() throws {
        let covered = try rules(
            #"{"width":"fill","minWidth":500,"aspectRatio":9,"weight":1}"#,
            weightedAxis: .horizontal,
            coverSize: (40, 30)
        )
        XCTAssertFalse(covered.needsResolvedLayout)
        XCTAssertEqual(covered.width, .points(40))
        XCTAssertEqual(covered.height, .points(30))
    }

    func testPlainWidthAndHeightKeepTheFramePath() throws {
        XCTAssertFalse(try rules(#"{"width":"fill","height":{"dp":20}}"#).needsResolvedLayout)
        XCTAssertTrue(try rules(#"{"maxWidth":20}"#).needsResolvedLayout)
        XCTAssertTrue(try rules(#"{"aspectRatio":1}"#).needsResolvedLayout)
        XCTAssertTrue(try rules(#"{"weight":1}"#, weightedAxis: .vertical).needsResolvedLayout)
    }

    func testTheContainerLayoutSignatureChangesWithTheNewFields() throws {
        let json = """
        {"type":"row","children":[{"type":"box","style":{"weight":1},"styleWhen":[
          {"when":{"key":"on","equals":true},"style":{"weight":2,"maxWidth":9}}]}]}
        """
        let root = try JSONDecoder().decode(PrototypeNode.self, from: Data(json.utf8))
        let off = root.containerLayoutSignature(state: ["on": .bool(false)]) { _ in true }
        let enabled = root.containerLayoutSignature(state: ["on": .bool(true)]) { _ in true }
        XCTAssertNotEqual(off, enabled)
    }

    // MARK: non-scalar state

    private func spec(state: String) -> Data {
        Data(#"{"id":"s","window":{"placement":{"type":"fullscreen"}},"state":\#(state),"root":{"type":"box"}}"#.utf8)
    }

    func testNonScalarStateValuesFailTheShowAsTheyDoOnAndroidAndTheHost() {
        for state in [#"{"k":null}"#, #"{"k":[1]}"#, #"{"k":{"a":1}}"#] {
            XCTAssertThrowsError(try JSONDecoder().decode(PrototypeSpec.self, from: spec(state: state)), state)
        }
    }

    func testScalarStateStillDecodes() throws {
        let decoded = try JSONDecoder().decode(
            PrototypeSpec.self,
            from: spec(state: #"{"a":"x","b":2.5,"c":false}"#)
        )
        XCTAssertEqual(decoded.state?["b"], .number(2.5))
    }
}

extension PrototypeSizingTests {
    func testRigidFirstRowMeasuresTextWithinRemainingWidth() {
        let bounds = PrototypeSizeRules(style: nil, constrainsWidth: true)
        let widths = PrototypeWeightedStack.mainSizes(
            available: 100, spacing: 10, weights: [nil, nil], minimums: [0, 0],
            leastFlexibleFirst: true, measuresFlexibleSlots: true
        ) { index, most in
            PrototypeSizing.resolve(bounds, proposed: (most, nil)) { maxWidth, _ in
                (min([70.0, 100][index], maxWidth ?? .infinity), 20)
            }.width
        }
        XCTAssertEqual(widths, [70, 20])
    }

    func testRigidFirstRowSharesGreedyControlAndCappedSpacerAfterLabel() throws {
        var spacer = try rules(#"{"minWidth":20,"maxWidth":60}"#)
        spacer.fillsByDefault = true
        for available in [340.0, 80] {
            let widths = PrototypeWeightedStack.mainSizes(
                available: available, spacing: 8, weights: [nil, 1, nil], minimums: [80, 20, 40],
                leastFlexibleFirst: true, measuresFlexibleSlots: true
            ) { index, most in
                switch index {
                case 0: max(most ?? 80, 80)
                case 1: PrototypeSizing.resolve(spacer, proposed: (most, nil)) { _, _ in (0, 10) }.width
                default: 40
                }
            }
            XCTAssertEqual(widths, available == 340 ? [224, 60, 40] : [80, 20, 40])
        }
        let ideal = PrototypeWeightedStack.mainSizes(
            available: nil, spacing: 8, weights: [nil, 1, nil], minimums: [80, 20, 40],
            leastFlexibleFirst: true, measuresFlexibleSlots: true
        ) { index, most in
            XCTAssertNil(most)
            return [80, 20, 40][index]
        }
        XCTAssertEqual(ideal, [80, 20, 40])
    }

    func testOverfullRowKeepsEveryControlMinimumAndOverflowsAtTheEnd() {
        let minimums = [Double](repeating: 44, count: 6)
        let widths = PrototypeRowSizing.widths(
            available: 200, spacing: 0, minimums: minimums,
            fills: [Bool](repeating: false, count: 6), priorities: [Double](repeating: 0, count: 6)
        ) { _, most in min(44, most ?? .infinity) }
        XCTAssertEqual(widths, minimums)
        var leading = 0.0
        let targets = widths.map { width in
            defer { leading += width }
            return CGRect(x: leading, y: 0, width: width, height: 44)
        }
        XCTAssertEqual(targets.map(\.minX), [0, 44, 88, 132, 176, 220])
        for index in 1 ..< targets.count {
            XCTAssertFalse(targets[index - 1].intersects(targets[index]))
        }
        XCTAssertEqual(targets.last?.maxX, 264)
    }

    func testNestedControlRowReportsItsMinimumAndReservesItInWeightedCoverRow() {
        func innerWidth(_ most: Double?) -> Double {
            PrototypeRowSizing.widths(
                available: most, spacing: 8, minimums: [44, 44],
                fills: [false, false], priorities: [0, 0]
            ) { _, offered in min(44, offered ?? .infinity) }.reduce(0, +) + 8
        }
        XCTAssertEqual(innerWidth(0), 96)
        var textOffer: Double?
        let widths = PrototypeWeightedStack.mainSizes(
            available: 342, spacing: 12, weights: [nil, 1, nil], minimums: [20, 0, innerWidth(0)],
            leastFlexibleFirst: true
        ) { index, most in
            if index == 0 {
                textOffer = most
                return min(286, most ?? .infinity)
            }
            return innerWidth(most)
        }
        XCTAssertEqual(textOffer, 222)
        XCTAssertEqual(widths, [222, 0, 96])
        XCTAssertEqual(widths.reduce(0, +) + 24, 342)
    }

    func testZeroWidthProbeReportsAuthoredWidthAndMinimum() throws {
        for json in [
            #"{"width":{"dp":40},"aspectRatio":1}"#,
            #"{"width":{"dp":40},"maxHeight":80}"#,
            #"{"minWidth":44}"#,
        ] {
            let control = try rules(json)
            XCTAssertEqual(size(control, in: (0, nil)).width, control.minWidth ?? 40)
        }
        let byHeight = try size(rules(#"{"height":{"dp":20},"aspectRatio":2}"#), in: (0, nil))
        XCTAssertEqual(byHeight.width, 40)
        XCTAssertEqual(byHeight.height, 20)
        let byWidth = try size(rules(#"{"width":{"dp":40},"aspectRatio":2}"#), in: (0, 0))
        XCTAssertEqual(byWidth.width, 40)
        XCTAssertEqual(byWidth.height, 20)
        XCTAssertEqual(try size(rules(#"{"width":{"dp":80},"maxWidth":40}"#), in: (0, nil)).width, 40)
        XCTAssertEqual(try size(rules(#"{"minWidth":44,"maxWidth":80}"#), in: (0, nil)).width, 44)
    }

    func testRowReservesSizedAvatarAndMinWidthBoxUsingRealSizingReports() throws {
        for json in [#"{"width":{"dp":40},"aspectRatio":1}"#, #"{"minWidth":44}"#] {
            let control = try rules(json)
            let minimum = size(control, in: (0, nil), content: (0, 10)).width
            let expected = control.minWidth ?? 40
            let widths = PrototypeRowSizing.widths(
                available: 100, spacing: 0, minimums: [10, minimum],
                fills: [false, false], priorities: [0, 0]
            ) { index, most in
                index == 0 ? min(200, most ?? .infinity)
                    : self.size(control, in: (most, nil), content: (0, 10)).width
            }
            XCTAssertEqual(widths, [100 - expected, expected])
        }
    }

    func testWeightedCoverRowReservesControlsAndBoundsWrappedColumn() {
        var offers: [Int: Double] = [:]
        let widths = PrototypeWeightedStack.mainSizes(
            available: 342, spacing: 12, weights: [nil, 1, nil, nil], minimums: [20, 0, 44, 44],
            leastFlexibleFirst: true
        ) { index, most in
            offers[index] = most
            return [286.0, 0, 44, 44][index]
        }
        XCTAssertEqual(offers[0], 218)
        XCTAssertNil(offers[1])
        XCTAssertEqual(offers[2], 44)
        XCTAssertEqual(offers[3], 44)
        XCTAssertEqual(widths, [218, 0, 44, 44])
        XCTAssertEqual(widths.reduce(0, +) + 36, 342)
    }

    func testWeightedCoverRowAtWideWidthKeepsIdealColumnAndFillsSpacer() {
        let widths = PrototypeWeightedStack.mainSizes(
            available: 440, spacing: 12, weights: [nil, 1, nil, nil], minimums: [20, 0, 44, 44],
            leastFlexibleFirst: true
        ) { index, _ in [286, 0, 44, 44][index] }
        XCTAssertEqual(widths, [286, 30, 44, 44])
        XCTAssertEqual(widths.reduce(0, +) + 36, 440)
    }

    func testWeightedRowSharesLeftoversProportionallyBetweenTwoChildren() {
        let widths = PrototypeWeightedStack.mainSizes(
            available: 200, spacing: 4, weights: [nil, 1, 3, nil], minimums: [20, 0, 0, 40],
            leastFlexibleFirst: true
        ) { index, _ in [20, 0, 0, 40][index] }
        XCTAssertEqual(widths, [20, 32, 96, 40])
        XCTAssertEqual(widths.reduce(0, +) + 12, 200)
    }

    func testWeightedRowThatFitsKeepsItsContentWidths() {
        let widths = PrototypeWeightedStack.mainSizes(
            available: 342, spacing: 12, weights: [nil, 1, nil, nil], minimums: [10, 0, 44, 44],
            leastFlexibleFirst: true
        ) { index, _ in [136, 0, 44, 44][index] }
        XCTAssertEqual(widths, [136, 82, 44, 44])
    }

    func testUnweightedCoverRowReservesControlsAndBoundsWrappedColumn() {
        var offers: [Int: Double] = [:]
        let widths = PrototypeRowSizing.widths(
            available: 342, spacing: 12,
            minimums: [20, 0, 44, 44], fills: [false, true, false, false], priorities: [0, 0, 0, 0]
        ) { index, most in
            offers[index] = most
            return min([286.0, 0, 44, 44][index], most ?? .infinity)
        }
        XCTAssertEqual(offers[0], 218)
        XCTAssertEqual(widths, [218, 0, 44, 44])
        XCTAssertEqual(widths.reduce(0, +) + 36, 342)
    }

    func testEquallyFlexibleChildrenUseAuthoredOrderAfterIdealMeasurement() {
        var offers: [Double?] = []
        let widths = PrototypeRowSizing.widths(
            available: 100, spacing: 0,
            minimums: [0, 0, 0], fills: [false, false, false], priorities: [0, 0, 0]
        ) { _, most in
            if most?.isFinite == true { offers.append(most) }
            return 70
        }
        XCTAssertEqual(offers, [70, 30, 0])
        XCTAssertEqual(widths, [70, 30, 0])
    }

    func testUnweightedRowThatFitsKeepsItsContentWidths() {
        let widths = PrototypeRowSizing.widths(
            available: 342, spacing: 12,
            minimums: [10, 44, 44], fills: [false, false, false], priorities: [0, 0, 0]
        ) { index, _ in [136, 44, 44][index] }
        XCTAssertEqual(widths, [136, 44, 44])
    }

    func testRowSpacersShareOnlyTheSpaceLeftAfterContent() {
        let widths = PrototypeRowSizing.widths(
            available: 200, spacing: 4,
            minimums: [20, 0, 0, 40], fills: [false, true, true, false], priorities: [0, 0, 0, 0]
        ) { index, most in
            index == 1 || index == 2 ? (most ?? 0) : [20, 0, 0, 40][index]
        }
        XCTAssertEqual(widths, [20, 64, 64, 40])
    }

    func testLeastFlexibleLabelsKeepTheirIdealWidthsBeforeLongContent() {
        for ideals in [[286.0, 40], [200, 30]] {
            let widths = PrototypeRowSizing.widths(
                available: 100, spacing: 4, minimums: [10, 10],
                fills: [false, false], priorities: [0, 0]
            ) { index, most in min(ideals[index], most ?? .infinity) }
            XCTAssertEqual(widths, [96 - ideals[1], ideals[1]])
        }
    }

    func testGreedyControlWithSmallIdealTakesRemainderBesideRigidLabel() {
        for minimum in [0.0, 30, 80] {
            let widths = PrototypeRowSizing.widths(
                available: 340, spacing: 8, minimums: [minimum, 40],
                fills: [false, false], priorities: [0, 0]
            ) { index, most in
                index == 0 ? max(most ?? 30, minimum) : 40
            }
            XCTAssertEqual(widths, [292, 40])
        }
    }

    func testGreedyControlRetainsTrackMinimumInOverfullRow() {
        let widths = PrototypeRowSizing.widths(
            available: 60, spacing: 8, minimums: [80, 40],
            fills: [false, false], priorities: [0, 0]
        ) { index, most in index == 0 ? max(most ?? 30, 80) : 40 }
        XCTAssertEqual(widths, [80, 40])
    }

    func testGreedyControlsShareRemainderWithoutAuthoredFill() {
        let widths = PrototypeRowSizing.widths(
            available: 340, spacing: 8, minimums: [30, 0, 40],
            fills: [false, false, false], priorities: [0, 0, 0]
        ) { index, most in index == 2 ? 40 : max(most ?? 30, index == 0 ? 30 : 0) }
        XCTAssertEqual(widths, [142, 142, 40])
    }

    func testSizedGreedyContentPreservesInfiniteProbesAndIdealSizes() throws {
        for json in [#"{"minWidth":120}"#, #"{"aspectRatio":2}"#, #"{"weight":1}"#] {
            let bounds = try rules(json, weightedAxis: .horizontal)
            let infinite = PrototypeSizing.resolve(bounds, proposed: (.infinity, nil)) { width, _ in
                (width ?? 30, 10)
            }
            let ideal = PrototypeSizing.resolve(bounds, proposed: (nil, nil)) { width, _ in
                (width ?? 30, 10)
            }
            XCTAssertEqual(infinite.width, .infinity, json)
            XCTAssertEqual(ideal.width, bounds.minWidth ?? 30, json)
        }
        let capped = try PrototypeSizing.resolve(
            rules(#"{"maxWidth":200}"#), proposed: (.infinity, nil)
        ) { width, _ in (width ?? 30, 10) }
        XCTAssertEqual(capped.width, 200)
        let fixed = try PrototypeSizing.resolve(
            rules(#"{"width":{"dp":80},"minWidth":40}"#), proposed: (.infinity, nil)
        ) { width, _ in (width ?? 30, 10) }
        XCTAssertEqual(fixed.width, 80)
    }

    func testSizedGreedyContentPreservesVerticalProbesAndBounds() throws {
        for maximum in [nil, 90.0] {
            var bounds = try rules(#"{"minHeight":40}"#)
            bounds.maxHeight = maximum
            let infinite = PrototypeSizing.resolve(bounds, proposed: (nil, .infinity)) { _, height in
                (30, height ?? 10)
            }
            XCTAssertEqual(infinite.height, maximum ?? .infinity)
            let ideal = PrototypeSizing.resolve(bounds, proposed: (nil, nil)) { _, height in
                (30, height ?? 10)
            }
            XCTAssertEqual(ideal.height, maximum ?? 40)
        }
    }

    func testSizedGreedyControlsShareWidthAndReturnCappedRemainders() throws {
        for maximum in [nil, 120.0] {
            var bounds = try rules(#"{"minWidth":80}"#)
            bounds.maxWidth = maximum
            let widths = PrototypeRowSizing.widths(
                available: 340, spacing: 8, minimums: [80, 0, 40],
                fills: [false, false, false], priorities: [0, 0, 0]
            ) { index, most in
                if index == 2 { return 40 }
                if index == 1 { return most ?? 30 }
                return PrototypeSizing.resolve(bounds, proposed: (most, nil)) { width, _ in
                    (width ?? 30, 10)
                }.width
            }
            XCTAssertEqual(widths, maximum == nil ? [142, 142, 40] : [120, 164, 40])
        }
    }

    func testWeightedRowSizesUnweightedGreedyContentBeforeWeights() {
        for available in [340.0, 60] {
            let widths = PrototypeWeightedStack.mainSizes(
                available: available, spacing: 4, weights: [nil, 1, 3, nil],
                minimums: [80, 0, 0, 40], leastFlexibleFirst: true
            ) { index, most in index == 0 ? max(most ?? 80, 80) : 40 }
            XCTAssertEqual(widths, [max(available - 52, 80), 0, 0, 40])
        }
        let capped = PrototypeWeightedStack.mainSizes(
            available: 340, spacing: 4, weights: [nil, 1, 3, nil], minimums: [80, 0, 0, 40],
            leastFlexibleFirst: true
        ) { index, most in index == 0 ? min(most ?? 80, 120) : 40 }
        XCTAssertEqual(capped, [120, 42, 126, 40])
        let ideal = PrototypeWeightedStack.mainSizes(
            available: nil, spacing: 4, weights: [nil, 1, 3, nil]
        ) { index, most in index == 0 ? (most ?? 80) : 40 }
        XCTAssertEqual(ideal, [80, 0, 0, 40])
    }

    func testNestedRowAndWeightedStackSizingDistinguishesNilAndInfiniteRoom() {
        for weighted in [false, true] {
            func nestedWidth(_ most: Double?) -> Double {
                let children: [Double]
                if weighted {
                    children = PrototypeWeightedStack.mainSizes(
                        available: most, spacing: 8, weights: [1, nil], minimums: [0, 40],
                        leastFlexibleFirst: true
                    ) { _, _ in 40 }
                } else {
                    children = PrototypeRowSizing.widths(
                        available: most, spacing: 8, minimums: [80, 40],
                        fills: [false, false], priorities: [0, 0]
                    ) { index, offered in index == 0 ? max(offered ?? 80, 80) : 40 }
                }
                return children.reduce(0, +) + 8
            }
            for available in [nil, Double.infinity, 340.0] {
                let widths = PrototypeRowSizing.widths(
                    available: available, spacing: 8, minimums: [24, nestedWidth(0)],
                    fills: [false, false], priorities: [0, 0]
                ) { index, most in index == 0 ? 24 : nestedWidth(most) }
                let expected = available == nil ? nestedWidth(nil) : available == .infinity ? .infinity : 308
                XCTAssertEqual(widths, [24, expected])
            }
        }
    }

    func testFillingDividersShareTheRemainderAroundAnIdealLabel() {
        let widths = PrototypeRowSizing.widths(
            available: 100, spacing: 4, minimums: [0, 5, 0],
            fills: [true, false, true], priorities: [0, 0, 0]
        ) { index, most in index == 1 ? min(20, most ?? 20) : (most ?? 0) }
        XCTAssertEqual(widths, [36, 20, 36])
    }

    func testFillMinimumIsReservedEvenWhenContentOverflows() {
        for available in [0.0, 50, 100] {
            let widths = PrototypeRowSizing.widths(
                available: available, spacing: 0, minimums: [10, 44, 44],
                fills: [false, true, false], priorities: [0, 0, 0]
            ) { index, most in
                index == 1 ? max(most ?? 44, 44) : min([200.0, 44, 44][index], most ?? .infinity)
            }
            XCTAssertEqual(widths, [max(available - 88, 10), 44, 44])
        }
    }

    func testCappedFillsHandBackUnusedWidthAndReportOnlyUsedWidth() {
        let widths = PrototypeRowSizing.widths(
            available: 300, spacing: 0, minimums: [0, 0],
            fills: [true, true], priorities: [0, 0]
        ) { index, most in index == 0 ? min(most ?? 40, 40) : (most ?? 0) }
        XCTAssertEqual(widths, [40, 260])
        let capped = PrototypeRowSizing.widths(
            available: 300, spacing: 0, minimums: [0, 0],
            fills: [true, true], priorities: [0, 0]
        ) { index, most in min(most ?? 0, [40.0, 60][index]) }
        XCTAssertEqual(capped, [40, 60])
        XCTAssertEqual(capped.reduce(0, +), 100)
    }

    func testFillMinimumLargerThanEqualShareRebalancesOtherFills() {
        let widths = PrototypeRowSizing.widths(
            available: 100, spacing: 0, minimums: [80, 0],
            fills: [true, true], priorities: [0, 0]
        ) { index, most in max(most ?? 0, [80.0, 0][index]) }
        XCTAssertEqual(widths, [80, 20])
    }

    func testFillMinimumLargerThanEqualShareRebalancesCappedFill() {
        let widths = PrototypeRowSizing.widths(
            available: 100, spacing: 0, minimums: [80, 0],
            fills: [true, true], priorities: [0, 0]
        ) { index, most in index == 0 ? max(most ?? 0, 80) : min(most ?? 0, 40) }
        XCTAssertEqual(widths, [80, 20])
    }

    func testWeightedRowKeepsDirectButtonLabelAndShrinksLongSibling() {
        let widths = PrototypeWeightedStack.mainSizes(
            available: 100, spacing: 4, weights: [nil, 1, nil],
            minimums: [10, 0, 10], priorities: [0, 0, 1], leastFlexibleFirst: true
        ) { index, most in min([200.0, 0, 40][index], most ?? .infinity) }
        XCTAssertEqual(widths, [52, 0, 40])
    }

    func testWeightedColumnPreservesAuthoredMinimumsWithoutAZeroShareJump() {
        for available in [99.5, 100, 100.5] {
            let heights = PrototypeWeightedStack.mainSizes(
                available: available, spacing: 0, weights: [nil, nil, nil, 1],
                minimums: [60, 60, 60, 0]
            ) { _, most in min(60, most ?? 60) }
            XCTAssertEqual(heights, [60, 60, 60, 0])
        }
    }

    func testButtonPriorityKeepsItsLabelBeforeOtherContentShrinks() {
        let widths = PrototypeRowSizing.widths(
            available: 100, spacing: 4,
            minimums: [10, 10], fills: [false, false], priorities: [0, 1]
        ) { index, most in min([90.0, 40][index], most ?? .infinity) }
        XCTAssertEqual(widths, [56, 40])
    }

    func testUnboundedRowKeepsIdealSizesIncludingFillingContent() {
        let widths = PrototypeRowSizing.widths(
            available: nil, spacing: 4,
            minimums: [10, 0], fills: [false, true], priorities: [0, 0]
        ) { index, most in
            XCTAssertNil(most)
            return [40, 20][index]
        }
        XCTAssertEqual(widths, [40, 20])
    }

    func testContentCentresOnlyOnWrappedAxes() throws {
        func anchor(_ json: String, weighted: PrototypeAxis? = nil) throws -> [Double] {
            let style = try JSONDecoder().decode(Style.self, from: Data(json.utf8))
            let fitting = PrototypeSizing.contentAnchor(
                PrototypeSizeRules(style: style, weightedAxis: weighted),
                alignment: (0, 1)
            )
            return [fitting.x, fitting.y]
        }
        XCTAssertEqual(try anchor(#"{"minWidth": 200}"#), [0.5, 0.5])
        XCTAssertEqual(try anchor(#"{"width": "wrap"}"#), [0.5, 0.5])
        XCTAssertEqual(try anchor(#"{"width": {"dp": 9}}"#), [0, 0.5])
        XCTAssertEqual(try anchor(#"{"width": "fill", "height": {"dp": 9}}"#), [0, 1])
        XCTAssertEqual(try anchor(#"{"weight": 1}"#, weighted: .horizontal), [0, 0.5])
        XCTAssertEqual(try anchor(#"{"aspectRatio": 2}"#), [0, 1])
    }
}
