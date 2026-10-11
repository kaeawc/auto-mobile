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
    func testContentCentresOnlyOnWrappedAxes() throws {
        func anchor(_ json: String, weighted: PrototypeAxis? = nil) throws -> [Double] {
            let style = try JSONDecoder().decode(Style.self, from: Data(json.utf8))
            let a = PrototypeSizing.contentAnchor(
                PrototypeSizeRules(style: style, weightedAxis: weighted),
                alignment: (0, 1)
            )
            return [a.x, a.y]
        }
        XCTAssertEqual(try anchor(#"{"minWidth": 200}"#), [0.5, 0.5])
        XCTAssertEqual(try anchor(#"{"width": "wrap"}"#), [0.5, 0.5])
        XCTAssertEqual(try anchor(#"{"width": {"dp": 9}}"#), [0, 0.5])
        XCTAssertEqual(try anchor(#"{"width": "fill", "height": {"dp": 9}}"#), [0, 1])
        XCTAssertEqual(try anchor(#"{"weight": 1}"#, weighted: .horizontal), [0, 0.5])
        XCTAssertEqual(try anchor(#"{"aspectRatio": 2}"#), [0, 1])
    }
}
