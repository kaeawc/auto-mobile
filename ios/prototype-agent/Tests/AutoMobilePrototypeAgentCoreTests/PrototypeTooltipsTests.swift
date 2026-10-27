@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeTooltipsTests: XCTestCase {
    private var fixtures: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test/fixtures/prototype-spec")
    }

    override static func setUp() {
        super.setUp()
        // Decode the generated contract once outside per-test timing.
        _ = try? PrototypeSpecStrictValidator.validate(data: Data("{}".utf8))
    }

    private func assertInvalidFixture(_ name: String) throws {
        struct Fixture: Decodable {
            let spec: JSONValue
            let expectedPath: String
            let expectedMessage: String
        }
        let fixture = try JSONDecoder().decode(
            Fixture.self,
            from: Data(contentsOf: fixtures.appendingPathComponent("invalid/\(name).json"))
        )
        let data = try JSONEncoder().encode(fixture.spec)
        XCTAssertThrowsError(try PrototypeSpecStrictValidator.validate(data: data)) { error in
            XCTAssertEqual(
                error as? PrototypeLoadError,
                .invalidSpec(path: fixture.expectedPath, message: fixture.expectedMessage),
                name
            )
        }
    }

    func testTooltipBadCaret() throws { try assertInvalidFixture("tooltip-bad-caret") }
    func testTooltipBlankText() throws { try assertInvalidFixture("tooltip-blank-text") }
    func testTooltipBothAnchors() throws { try assertInvalidFixture("tooltip-both-anchors") }
    func testTooltipDismissStateType() throws { try assertInvalidFixture("tooltip-dismiss-state-type") }
    func testTooltipDuplicateTarget() throws { try assertInvalidFixture("tooltip-duplicate-target") }
    func testTooltipEmptyDismiss() throws { try assertInvalidFixture("tooltip-empty-dismiss") }
    func testTooltipEqualsType() throws { try assertInvalidFixture("tooltip-equals-type") }
    func testTooltipMissingAnchor() throws { try assertInvalidFixture("tooltip-missing-anchor") }
    func testTooltipRepeatDuplicateTarget() throws { try assertInvalidFixture("tooltip-repeat-duplicate-target") }
    func testTooltipRepeatEmptyTarget() throws { try assertInvalidFixture("tooltip-repeat-empty-target") }
    func testTooltipSelfTarget() throws { try assertInvalidFixture("tooltip-self-target") }
    func testTooltipSpotlightFraction() throws { try assertInvalidFixture("tooltip-spotlight-fraction") }
    func testTooltipSpotlightPadding() throws { try assertInvalidFixture("tooltip-spotlight-padding") }
    func testTooltipSpotlightUnknownField() throws { try assertInvalidFixture("tooltip-spotlight-unknown-field") }
    func testTooltipStateType() throws { try assertInvalidFixture("tooltip-state-type") }
    func testTooltipUnknownField() throws { try assertInvalidFixture("tooltip-unknown-field") }
    func testTooltipUnknownTarget() throws { try assertInvalidFixture("tooltip-unknown-target") }

    func spec(spotlight: Bool = false, onTap: Bool = false, equals: Bool = true) throws -> PrototypeSpec {
        try JSONDecoder().decode(PrototypeSpec.self, from: Data("""
        {"id":"tip","window":{"placement":{"type":"fullscreen"}},"state":{"open":\(equals)},
         "root":{"type":"column","children":[{"type":"button","id":"target","label":"Help"},
           {"type":"tooltip","testTag":"hint","text":"Hint","anchorTo":"target",
            "openWhen":{"key":"open","equals":\(equals)},
            "onDismiss":[{"type":"emit","name":"dismissed"}]
            \(spotlight ? ",\"spotlight\":{}" : "")
            \(onTap ? ",\"onTap\":[{\"type\":\"emit\",\"name\":\"next\"}]" : "")}]}}
        """.utf8))
    }

    func testDismissWritesInverseBeforeActionsAndOnTapOverridesDismissal() throws {
        for equals in [true, false] {
            var session = PrototypeSession()
            let spec = try spec(equals: equals)
            session.show(spec)
            let tap = try XCTUnwrap(spec.root.tapTarget(identifier: "hint", state: session.state))
            let events = try XCTUnwrap(session.activate(tap))
            XCTAssertEqual(events.map(\.name), ["change", "dismissed"])
            XCTAssertEqual(events.last?.state["open"], .bool(!equals))
        }
        var session = PrototypeSession()
        let spec = try spec(onTap: true)
        session.show(spec)
        let tap = try XCTUnwrap(spec.root.tapTarget(identifier: "hint", state: session.state))
        XCTAssertEqual(session.activate(tap)?.map(\.name), ["next"])
        XCTAssertEqual(session.state["open"], .bool(true))
    }

    func testSpotlightBlockingCloseTagAndCutout() throws {
        for spotlight in [false, true] {
            let spec = try spec(spotlight: spotlight)
            XCTAssertEqual(spec.root.blocksPage(state: ["open": .bool(true)], pages: [:]), spotlight)
            XCTAssertFalse(spec.root.blocksPage(state: ["open": .bool(false)], pages: [:]))
            let tooltip = try XCTUnwrap(spec.root.children?.last)
            XCTAssertEqual(spec.root.openModals(state: ["open": .bool(true)], pages: [:]).map(\.type), ["tooltip"])
            XCTAssertFalse(tooltip.drawsInPlace { _ in true })
            XCTAssertEqual(prototypeAccessibilityGrouping(type: "tooltip", tappable: true), .leaf)
            if spotlight {
                var session = PrototypeSession()
                session.show(spec)
                let close = try XCTUnwrap(spec.root.tapTarget(identifier: "hint.close", state: session.state))
                XCTAssertEqual(session.activate(close)?.map(\.name), ["change", "dismissed"])
            }
        }
        let spotlight = try JSONDecoder().decode(TooltipSpotlight.self, from: Data("{}".utf8))
        XCTAssertEqual(
            PrototypeTooltips.spotlightRect(target: CGRect(x: 20, y: 30, width: 40, height: 50), spotlight: spotlight),
            CGRect(x: 12, y: 22, width: 56, height: 66)
        )
    }

    func testHiddenTargetDoesNotBlockPageAndAuthoredSpotlightPadding() throws {
        let spec = try JSONDecoder().decode(PrototypeSpec.self, from: Data("""
        {"id":"hidden","window":{"placement":{"type":"fullscreen"}},"state":{"open":true,"shown":false},
         "root":{"type":"column","children":[
          {"type":"button","id":"target","label":"Help","visibleWhen":{"key":"shown","equals":true}},
          {"type":"tooltip","text":"Hint","anchorTo":"target","spotlight":{},
           "openWhen":{"key":"open","equals":true}}]}}
        """.utf8))
        XCTAssertNil(spec.root.renderedNode(id: "target", state: spec.state ?? [:], pages: [:], stacks: [:]))
        XCTAssertFalse(spec.root.blocksPage(state: spec.state ?? [:], pages: [:]))
        let spotlight = try JSONDecoder().decode(
            TooltipSpotlight.self,
            from: Data("{\"padding\":0,\"cornerRadius\":64}".utf8)
        )
        let rect = CGRect(x: 10, y: 20, width: 30, height: 40)
        XCTAssertEqual(PrototypeTooltips.spotlightRect(target: rect, spotlight: spotlight), rect)
        XCTAssertEqual(PrototypeHostLayer.owner(of: CGPoint(x: 15, y: 25), hitRects: ["modal.0": rect]), .top)
        XCTAssertNil(PrototypeHostLayer.owner(of: CGPoint(x: 100, y: 100), hitRects: ["modal.0": rect]))
    }

    func testMissingRenderedTargetDoesNotResolveAndBoundsAnchorIsNotLayered() throws {
        let spec = try spec()
        XCTAssertNil(spec.root.renderedNode(id: "missing", state: [:], pages: [:], stacks: [:]))
        let data = try Data(contentsOf: fixtures.appendingPathComponent("valid/tooltip-bounds-anchor.json"))
        let bounds = try JSONDecoder().decode(PrototypeSpec.self, from: data)
        XCTAssertTrue(bounds.root.layeredAnchors(state: bounds.state ?? [:], pages: [:]).isEmpty)
    }
}
