@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeSpecDecodingTests: XCTestCase {
    /// A contract-valid placement: a sheet needs its `edge` and `height`, a floating window its
    /// `gravity` and `offset`.
    private func placementObject(_ type: String) -> [String: Any] {
        switch type {
        case "sheet": ["type": type, "edge": "bottom", "height": 200]
        case "floating": ["type": type, "gravity": "center", "offset": ["x": 0, "y": 0]]
        default: ["type": type]
        }
    }

    func testWindowDeadTapsDecodesAndRejectsNonBoolean() throws {
        for value in [true, false] {
            let data = Data("{\"placement\":{\"type\":\"fullscreen\"},\"deadTaps\":\(value)}".utf8)
            XCTAssertEqual(try JSONDecoder().decode(WindowSpec.self, from: data).deadTaps, value)
        }
        for value in ["1", "\"true\""] {
            let data = Data("{\"placement\":{\"type\":\"fullscreen\"},\"deadTaps\":\(value)}".utf8)
            XCTAssertThrowsError(try JSONDecoder().decode(WindowSpec.self, from: data))
        }
    }

    func testWindowChromeDecodesOrNamesTheInvalidField() throws {
        for placement in ["fullscreen", "sheet", "floating"] {
            for value: String? in [nil, "none", "bar"] {
                var window: [String: Any] = ["placement": placementObject(placement)]
                if let value { window["chrome"] = value }
                let data = try JSONSerialization.data(withJSONObject: window)
                XCTAssertEqual(try JSONDecoder().decode(WindowSpec.self, from: data).chrome, value)
            }
        }
        XCTAssertThrowsError(try JSONDecoder().decode(WindowSpec.self, from: Data(
            #"{"placement":{"type":"fullscreen"},"chrome":"hidden"}"#.utf8
        ))) { error in
            guard case let DecodingError.dataCorrupted(context) = error else {
                return XCTFail("Expected a window.chrome validation error, got \(error)")
            }
            XCTAssertTrue(context.debugDescription.contains("window.chrome"))
        }
    }

    func testNullWindowChromeDecodesAsAbsent() throws {
        let data = Data(#"{"placement":{"type":"fullscreen"},"chrome":null}"#.utf8)
        XCTAssertNil(try JSONDecoder().decode(WindowSpec.self, from: data).chrome)
    }

    func testNonStringWindowChromeFailsNamingItsPath() {
        for value in ["1", "true"] {
            let data = Data("""
            {"id":"chrome","window":{"placement":{"type":"fullscreen"},"chrome":\(value)},
             "root":{"type":"text","text":"Chrome"}}
            """.utf8)
            XCTAssertThrowsError(try JSONDecoder().decode(PrototypeSpec.self, from: data)) { error in
                guard case let DecodingError.typeMismatch(_, context) = error else {
                    return XCTFail("Expected a window.chrome type error, got \(error)")
                }
                XCTAssertEqual(context.codingPath.map(\.stringValue).joined(separator: "."), "window.chrome")
            }
        }
    }

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
            .appendingPathComponent("test/fixtures/prototype-spec/valid")
        let files = try FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "json" }
        XCTAssertGreaterThan(files.count, 20)
        let names = Set(files.map(\.lastPathComponent))
        for name in [
            "text-spans",
            "text-spans-max",
            "text-spans-tappable",
            "text-spans-placeholders",
            "text-spans-plain-text",
        ] {
            XCTAssertTrue(names.contains("\(name).json"))
        }
        for file in files {
            XCTAssertNoThrow(
                try JSONDecoder().decode(PrototypeSpec.self, from: Data(contentsOf: file)),
                file.lastPathComponent
            )
        }
    }

    func testStyleFormsAddedAfterThePrototypeDecode() throws {
        let node = try JSONDecoder().decode(PrototypeNode.self, from: Data("""
        {"type":"text","text":"x","style":{"fontFamily":{"asset":"brand"},"cornerRadius":{"topStart":4},
         "shadowColor":"primary","offset":{"x":1,"y":2},"lineHeight":20,"letterSpacing":-1,
         "textDecoration":"underline","fontStyle":"italic","overflow":"ellipsis","elevation":3}}
        """.utf8))
        let style = try XCTUnwrap(node.style)
        XCTAssertEqual(style.fontFamily, .asset("brand"))
        XCTAssertEqual(style.cornerRadius, .corners(topStart: 4, topEnd: 0, bottomEnd: 0, bottomStart: 0))
        XCTAssertEqual(style.offset?.y, 2)
        XCTAssertEqual(style.textDecoration, "underline")
        let token = try JSONDecoder().decode(
            Style.self,
            from: Data(#"{"cornerRadius":"large","fontFamily":"serif"}"#.utf8)
        )
        XCTAssertEqual(token.cornerRadius, .token("large"))
        XCTAssertEqual(PrototypeShapes.standard.resolve(.token("large")), .uniform(16))
        XCTAssertEqual(token.fontFamily, .keyword("serif"))
    }

    func testConditionWithoutAComparisonIsRejected() {
        XCTAssertThrowsError(try condition(#"{"key":"ready"}"#))
    }

    /// Node and action types the shared validator added after the prototype (switch, checkbox,
    /// button, toggle, increment, detents, anchors, motion) decode instead of failing show_prototype.
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
        let spec = try JSONDecoder().decode(PrototypeSpec.self, from: Data(json.utf8))
        let children = try XCTUnwrap(spec.root.children)
        XCTAssertEqual(children.map(\.type), ["switch", "checkbox", "button", "text", "bottomSheet"])
        XCTAssertEqual(children[0].label, "Wi-Fi")
        XCTAssertEqual(children[2].variant, "outlined")
        XCTAssertEqual(children[2].onTap?.last?.incrementAmount, 2)
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

final class PrototypeAccessibilityLabelTests: XCTestCase {
    private func node(_ json: String) throws -> PrototypeNode {
        try JSONDecoder().decode(PrototypeNode.self, from: Data(json.utf8))
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
        XCTAssertEqual(interpolatePrototypeText("a {missing} b", state: state, pager: nil), "a {missing} b")
    }
}
