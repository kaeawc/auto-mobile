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
