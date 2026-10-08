@testable import AutoMobileOverlayAgentCore
import XCTest

final class OverlaySpecDecodingTests: XCTestCase {
    private func condition(_ json: String) throws -> Condition {
        try JSONDecoder().decode(Condition.self, from: Data(json.utf8))
    }

    func testEveryValidatorConditionFormDecodesAndEvaluates() throws {
        let state: [String: JSONValue] = ["ready": .bool(true), "count": .number(3), "name": .string("x")]
        let cases: [(String, Bool)] = [
            (#"{"key":"ready","equals":true}"#, true),
            (#"{"key":"ready","notEquals":true}"#, false),
            (#"{"key":"missing","notEquals":true}"#, true),
            (#"{"key":"count","gt":2}"#, true),
            (#"{"key":"count","lt":3}"#, false),
            (#"{"key":"name","gt":0}"#, false),
            (#"{"key":"missing","lt":10}"#, false),
            (#"{"all":[{"key":"ready","equals":true},{"key":"count","gt":1}]}"#, true),
            (#"{"any":[{"key":"ready","equals":false},{"key":"name","equals":"x"}]}"#, true),
            (#"{"not":{"all":[{"key":"ready","equals":true}]}}"#, false),
        ]
        for (json, expected) in cases {
            XCTAssertEqual(try condition(json).holds(state), expected, json)
        }
    }

    /// Every spec the shared validator accepts must decode on iOS too (#10440).
    func testEverySharedValidFixtureDecodes() throws {
        let dir = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test/fixtures/overlay-spec/valid")
        let files = try FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "json" }
        XCTAssertGreaterThan(files.count, 20)
        for file in files {
            XCTAssertNoThrow(
                try JSONDecoder().decode(OverlaySpec.self, from: Data(contentsOf: file)),
                file.lastPathComponent
            )
        }
    }

    func testStyleFormsAddedAfterThePrototypeDecode() throws {
        let node = try JSONDecoder().decode(OverlayNode.self, from: Data("""
        {"type":"text","text":"x","style":{"fontFamily":{"asset":"brand"},"cornerRadius":{"topStart":4},
         "shadowColor":"primary","offset":{"x":1,"y":2},"lineHeight":20,"letterSpacing":-1,
         "textDecoration":"underline","fontStyle":"italic","overflow":"ellipsis","elevation":3}}
        """.utf8))
        let style = try XCTUnwrap(node.style)
        XCTAssertEqual(style.fontFamily, .asset("brand"))
        XCTAssertEqual(style.cornerRadius, .corners(topStart: 4, topEnd: 0, bottomEnd: 0, bottomStart: 0))
        XCTAssertEqual(style.offset?.y, 2)
        XCTAssertEqual(style.textDecoration, "underline")
        let token = try JSONDecoder().decode(Style.self, from: Data(#"{"cornerRadius":"large","fontFamily":"serif"}"#.utf8))
        XCTAssertEqual(token.cornerRadius, .uniform(16))
        XCTAssertEqual(token.fontFamily, .keyword("serif"))
    }

    func testConditionWithoutAComparisonIsRejected() {
        XCTAssertThrowsError(try condition(#"{"key":"ready"}"#))
    }

    /// Node and action types the shared validator added after the prototype (switch, checkbox,
    /// button, toggle, increment, detents, anchors, motion) decode instead of failing show_overlay.
    func testCurrentSpecVocabularyDecodes() throws {
        let json = """
        {"id":"s","motion":"standard","window":{"placement":{"type":"fullscreen"},"opacity":90},
         "state":{"on":false,"n":0,"sheet":true},
         "root":{"type":"column","children":[
           {"type":"switch","stateKey":"on","label":"Wi-Fi","onTap":[{"type":"emit","name":"x"}]},
           {"type":"checkbox","stateKey":"on"},
           {"type":"button","label":"Go","variant":"outlined",
            "onTap":[{"type":"toggle","key":"on"},{"type":"increment","key":"n","by":2}]},
           {"type":"text","text":"anchored","visibleWhen":{"key":"n","notEquals":0},
            "anchor":{"type":"bounds","bounds":{"x":0,"y":0,"width":10,"height":10}}},
           {"type":"bottomSheet","openWhen":{"key":"sheet","equals":true},
            "detents":["half",{"dp":120},"full"],"dismissOnSwipe":true,
            "child":{"type":"text","text":"sheet"}}
         ]}}
        """
        let spec = try JSONDecoder().decode(OverlaySpec.self, from: Data(json.utf8))
        let children = try XCTUnwrap(spec.root.children)
        XCTAssertEqual(children.map(\.type), ["switch", "checkbox", "button", "text", "bottomSheet"])
        XCTAssertEqual(children[0].label, "Wi-Fi")
        XCTAssertEqual(children[2].variant, "outlined")
        XCTAssertEqual(children[2].onTap?.last?.by, 2)
        XCTAssertEqual(children[3].visibleWhen, .notEquals(key: "n", value: .number(0)))
        XCTAssertEqual(children[4].detents, [.half, .points(120), .full])
    }

    func testDetentHeightsMatchAndroid() {
        XCTAssertEqual(Detent.half.height(in: 800), 400)
        XCTAssertEqual(Detent.full.height(in: 800), 800)
        XCTAssertEqual(Detent.points(120).height(in: 800), 120)
        XCTAssertEqual(Detent.points(1200).height(in: 800), 800)
    }

    func testIntValueIsNilOutsideIntRange() {
        XCTAssertEqual(JSONValue.number(2.9).intValue, 2)
        XCTAssertNil(JSONValue.number(1e300).intValue)
    }
}

final class OverlayAccessibilityLabelTests: XCTestCase {
    private func node(_ json: String) throws -> OverlayNode {
        try JSONDecoder().decode(OverlayNode.self, from: Data(json.utf8))
    }

    private let state: [String: JSONValue] = ["n": .number(3), "who": .string("Ada")]

    func testContentDescriptionDecodesAndWinsOverText() throws {
        let box = try node(#"{"type":"text","text":"Close","contentDescription":"Close dialog"}"#)
        XCTAssertEqual(box.contentDescription, "Close dialog")
        XCTAssertEqual(box.accessibilityLabel(state: [:], pager: nil, tappable: false), "Close dialog")
    }

    func testPlaceholdersAreFilledInTheDescription() throws {
        let box = try node(#"{"type":"box","contentDescription":"{who} has {n} items"}"#)
        XCTAssertEqual(box.accessibilityLabel(state: state, pager: nil, tappable: false), "Ada has 3 items")
    }

    func testPagerPlaceholdersResolveInsideAPager() throws {
        let text = try node(#"{"type":"box","contentDescription":"Page {page} of {pageCount}"}"#)
        let label = text.accessibilityLabel(state: [:], pager: PagerPosition(page: 1, count: 4), tappable: false)
        XCTAssertEqual(label, "Page 2 of 4")
    }

    func testTextIsUsedWhenThereIsNoDescription() throws {
        let text = try node(#"{"type":"text","text":"Hello {who}"}"#)
        XCTAssertEqual(text.accessibilityLabel(state: state, pager: nil, tappable: false), "Hello Ada")
    }

    func testEmptyResolvedDescriptionFallsThroughToText() throws {
        let text = try node(#"{"type":"text","text":"Fallback","contentDescription":""}"#)
        XCTAssertEqual(text.accessibilityLabel(state: [:], pager: nil, tappable: false), "Fallback")
    }

    func testTappableIconReadsAsItsNameButDecorativeIconDoesNot() throws {
        let icon = try node(#"{"type":"icon","name":"settings"}"#)
        XCTAssertEqual(icon.accessibilityLabel(state: [:], pager: nil, tappable: true), "settings")
        XCTAssertNil(icon.accessibilityLabel(state: [:], pager: nil, tappable: false))
    }

    func testDescriptionBeatsIconName() throws {
        let icon = try node(#"{"type":"icon","name":"settings","contentDescription":"Open settings"}"#)
        XCTAssertEqual(icon.accessibilityLabel(state: [:], pager: nil, tappable: true), "Open settings")
    }

    func testContainersAreNotLabelledByKind() throws {
        let row = try node(#"{"type":"row"}"#)
        XCTAssertNil(row.accessibilityLabel(state: [:], pager: nil, tappable: true))
    }

    func testUnknownPlaceholderIsLeftAsWritten() {
        XCTAssertEqual(interpolateOverlayText("a {missing} b", state: state, pager: nil), "a {missing} b")
    }
}
