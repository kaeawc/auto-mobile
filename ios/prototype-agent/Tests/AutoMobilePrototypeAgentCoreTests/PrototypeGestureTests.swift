@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeGestureTests: XCTestCase {
    private func sharedFixture(_ name: String) throws -> PrototypeSpec {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let url = root.appendingPathComponent("test/fixtures/prototype-spec/valid/\(name).json")
        return try JSONDecoder().decode(PrototypeSpec.self, from: Data(contentsOf: url))
    }

    private func node(_ json: String) throws -> PrototypeNode {
        try JSONDecoder().decode(PrototypeNode.self, from: Data(json.utf8))
    }

    func testSharedGestureFixtureDecodesAllThreeLists() throws {
        let spec = try sharedFixture("gestures")
        XCTAssertEqual(spec.root.onTap?.map(\.type), ["emit"])
        XCTAssertEqual(spec.root.onLongPress?.map(\.type), ["setState", "toggle", "emit"])
        XCTAssertEqual(spec.root.onLongPress?.first?.key, "picked")
        XCTAssertEqual(spec.root.onLongPress?.first?.value, .string("row"))
        XCTAssertEqual(spec.root.onDoubleTap?.map(\.type), ["emit"])
        XCTAssertEqual(spec.root.children?[0].onLongPress?.map(\.type), ["emit"])
        XCTAssertEqual(spec.root.children?[1].onDoubleTap?.map(\.type), ["emit"])
        XCTAssertNil(PrototypeStateValidator.rejection(root: spec.root, state: spec.state ?? [:]))
    }

    func testSharedRepeatFixtureBindsLongPressLikeTap() throws {
        let spec = try sharedFixture("gestures-repeat")
        let rows = try XCTUnwrap(spec.root.children?[1].children)
        XCTAssertEqual(rows.count, 2)
        for (index, id) in ["a", "b"].enumerated() {
            let repeated = try XCTUnwrap(rows[index].children?[1])
            for actions in [repeated.onTap, repeated.onLongPress] {
                let bound = try XCTUnwrap(actions)
                XCTAssertEqual(bound.map(\.type), ["setState", "setState", "emit"])
                XCTAssertEqual(bound.map(\.value), [.string(id), .number(Double(index)), nil])
                XCTAssertEqual(bound[2].name, "pick_\(id)")
                XCTAssertEqual(bound[2].payload, .object(["id": .string("{item.id}")]))
            }
            XCTAssertNil(repeated.onDoubleTap)
        }
    }

    func testRepeatBindsBothGestureKeysAndScalarValues() throws {
        let spec = try JSONDecoder().decode(PrototypeSpec.self, from: Data("""
        {"id":"gestures","window":{"placement":{"type":"fullscreen"}},"root":{
          "type":"column","repeat":{"items":[{"id":"a","value":true},{"id":"b","value":false}],"as":"item"},
          "children":[{"type":"icon","name":"favorite",
            "onLongPress":[{"type":"setState","key":"liked_{item.id}","value":"{item.value}"}],
            "onDoubleTap":[{"type":"setState","key":"last_{index}","value":"{index}"},
                           {"type":"emit","name":"pick_{item.id}"}]}]}}
        """.utf8))
        let children = try XCTUnwrap(spec.root.children)
        XCTAssertEqual(children.count, 2)
        XCTAssertEqual(children.map { $0.onLongPress?.first?.key }, ["liked_a", "liked_b"])
        XCTAssertEqual(children.map { $0.onLongPress?.first?.value }, [.bool(true), .bool(false)])
        XCTAssertEqual(children.map { $0.onDoubleTap?.first?.key }, ["last_0", "last_1"])
        XCTAssertEqual(children.map { $0.onDoubleTap?.first?.value }, [.number(0), .number(1)])
        XCTAssertEqual(children.map { $0.onDoubleTap?.last?.name }, ["pick_a", "pick_b"])
    }

    func testStateValidatorChecksBothGestureListsInDescendants() throws {
        for gesture in ["onLongPress", "onDoubleTap"] {
            let root = try node("""
            {"type":"column","children":[{"type":"box","child":{"type":"text","text":"Toggle",
              "\(gesture)":[{"type":"toggle","key":"liked"}]}}]}
            """)
            XCTAssertNil(PrototypeStateValidator.rejection(root: root, state: ["liked": .bool(false)]))
            XCTAssertEqual(
                PrototypeStateValidator.rejection(root: root, state: ["liked": .string("bad")]),
                "Toggle requires a boolean state key"
            )
            XCTAssertEqual(
                PrototypeStateValidator.rejection(root: root, state: [:]),
                "Toggle requires a boolean state key"
            )
        }
    }

    func testSetStateCannotInvalidateAKeyUsedByEitherGesture() throws {
        for gesture in ["onLongPress", "onDoubleTap"] {
            let spec = try JSONDecoder().decode(PrototypeSpec.self, from: Data("""
            {"id":"gestures","window":{"placement":{"type":"fullscreen"}},"state":{"liked":false},
             "root":{"type":"text","text":"Toggle",
               "onTap":[{"type":"setState","key":"liked","value":"bad"}],
               "\(gesture)":[{"type":"toggle","key":"liked"}]}}
            """.utf8))
            var session = PrototypeSession()
            session.show(spec)
            XCTAssertTrue(try session.run(XCTUnwrap(spec.root.onTap)).isEmpty)
            XCTAssertEqual(session.state["liked"], .bool(false))
        }
    }

    func testGestureSetStateRejectsAnInvalidControlKeyValue() throws {
        for gesture in ["onLongPress", "onDoubleTap"] {
            let spec = try JSONDecoder().decode(PrototypeSpec.self, from: Data("""
            {"id":"gestures","window":{"placement":{"type":"fullscreen"}},"state":{"liked":false},
             "root":{"type":"row","\(gesture)":[{"type":"setState","key":"liked","value":"bad"}],
               "children":[{"type":"switch","stateKey":"liked"}]}}
            """.utf8))
            var session = PrototypeSession()
            session.show(spec)
            let actions = gesture == "onLongPress" ? spec.root.onLongPress : spec.root.onDoubleTap
            XCTAssertTrue(try session.run(XCTUnwrap(actions)).isEmpty)
            XCTAssertEqual(session.state["liked"], .bool(false))
        }
    }

    func testAnyActionListMakesANodeInteractive() throws {
        XCTAssertFalse(try node(#"{"type":"icon","name":"favorite"}"#).isInteractive)
        for gesture in ["onTap", "onLongPress", "onDoubleTap"] {
            let interactive = try node("""
            {"type":"icon","name":"favorite","\(gesture)":[{"type":"emit","name":"picked"}]}
            """)
            XCTAssertTrue(interactive.isInteractive)
            XCTAssertEqual(
                interactive.accessibilityLabel(state: [:], pager: nil, tappable: interactive.isInteractive),
                "favorite"
            )
            XCTAssertEqual(prototypeAccessibilityGrouping(type: "row", tappable: interactive.isInteractive), .combine)
        }
    }

    func testGesturePlanOrdersLayersInnermostFirst() throws {
        let root =
            try node(
                #"{"type":"text","text":"Tap","onTap":[{"type":"emit","name":"tap"}],"onLongPress":[{"type":"emit","name":"hold"}],"onDoubleTap":[{"type":"emit","name":"double"}]}"#
            )
        XCTAssertEqual(root.gesturePlan.layers, [.longPress, .doubleTap, .singleTap])
        XCTAssertTrue(root.gesturePlan.consumesSingleTap)
    }

    func testGestureOnlyPlansNeverInstallSingleTap() throws {
        for fields in [
            #""onLongPress":[{"type":"emit","name":"hold"}]"#,
            #""onDoubleTap":[{"type":"emit","name":"double"}]"#,
            #""onLongPress":[{"type":"emit","name":"hold"}],"onDoubleTap":[{"type":"emit","name":"double"}]"#,
        ] {
            let root = try node("{\"type\":\"text\",\"text\":\"Tap\",\(fields)}")
            XCTAssertFalse(root.gesturePlan.layers.isEmpty)
            XCTAssertFalse(root.gesturePlan.layers.contains(.singleTap))
            XCTAssertFalse(root.gesturePlan.consumesSingleTap)
        }
    }

    func testNoGesturesAndTapOnlyPlans() throws {
        let plain = try node(#"{"type":"text","text":"Plain"}"#)
        XCTAssertEqual(plain.gesturePlan.layers, [])
        XCTAssertFalse(plain.gesturePlan.consumesSingleTap)
        let tapped = try node(#"{"type":"text","text":"Tap","onTap":[{"type":"emit","name":"tap"}]}"#)
        XCTAssertEqual(tapped.gesturePlan.layers, [.singleTap])
        XCTAssertTrue(tapped.gesturePlan.consumesSingleTap)
    }

    func testTheAgentAdvertisesGestures() {
        XCTAssertEqual(PrototypeAgentProtocol.gesturesCapability, "prototype_gestures_v1")
        XCTAssertTrue(PrototypeAgentProtocol.capabilities.contains(PrototypeAgentProtocol.gesturesCapability))
        XCTAssertTrue(PrototypeAgentProtocol.capabilities.contains(PrototypeAgentProtocol.gesturesCapability))
    }
}
