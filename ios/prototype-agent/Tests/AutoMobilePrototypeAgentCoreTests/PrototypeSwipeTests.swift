@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeSwipeTests: XCTestCase {
    // A 360 wide row: one start button (80) and two end buttons (160).
    private let plain = PrototypeSwipe.Geometry(startWidth: 80, endWidth: 160, rowWidth: 360, fullSwipe: false)
    private var full: PrototypeSwipe.Geometry {
        var geometry = plain
        geometry.fullSwipe = true
        return geometry
    }

    private func node(_ json: String) throws -> PrototypeNode {
        try JSONDecoder().decode(PrototypeNode.self, from: Data(json.utf8))
    }

    private var fixtures: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test/fixtures/prototype-spec")
    }

    // MARK: Thresholds

    func testASlowReleasePastFortyPercentOfTheRevealOpensAndShortOfItCloses() {
        XCTAssertEqual(PrototypeSwipe.settle(offset: -64, velocity: 0, plain), .open(.end))
        XCTAssertEqual(PrototypeSwipe.settle(offset: -63, velocity: 0, plain), .closed)
        XCTAssertEqual(PrototypeSwipe.settle(offset: 32, velocity: 0, plain), .open(.start))
        XCTAssertEqual(PrototypeSwipe.settle(offset: 31, velocity: 0, plain), .closed)
    }

    func testAFlingDecidesRegardlessOfPosition() {
        XCTAssertEqual(PrototypeSwipe.settle(offset: -10, velocity: -500, plain), .open(.end))
        XCTAssertEqual(PrototypeSwipe.settle(offset: -150, velocity: 500, plain), .closed)
        XCTAssertEqual(PrototypeSwipe.settle(offset: -150, velocity: 499, plain), .open(.end))
    }

    func testASideWithoutActionsNeverOpensAndResistsEntirely() {
        var onlyEnd = plain
        onlyEnd.startWidth = 0
        XCTAssertEqual(PrototypeSwipe.settle(offset: 50, velocity: 900, onlyEnd), .closed)
        XCTAssertEqual(PrototypeSwipe.rubberBanded(50, onlyEnd), 0)
    }

    func testDraggingInsideTheRevealIsFreeAndBeyondItIsRubberBanded() {
        XCTAssertEqual(PrototypeSwipe.rubberBanded(-100, plain), -100)
        XCTAssertEqual(PrototypeSwipe.rubberBanded(-160, plain), -160)
        XCTAssertEqual(PrototypeSwipe.rubberBanded(-210, plain), -175, accuracy: 0.001)
        XCTAssertEqual(PrototypeSwipe.rubberBanded(120, plain), 92, accuracy: 0.001)
    }

    func testWithFullSwipeTheFreeRangeIsTheWholeRow() {
        XCTAssertEqual(PrototypeSwipe.rubberBanded(-300, full), -300)
        XCTAssertEqual(PrototypeSwipe.rubberBanded(-460, full), -390, accuracy: 0.001)
    }

    func testAFullSwipeNeedsFullSwipeAndSixtyPercentOfTheRowOrAHardFling() {
        XCTAssertEqual(PrototypeSwipe.settle(offset: -217, velocity: 0, full), .full(.end))
        XCTAssertEqual(PrototypeSwipe.settle(offset: -215, velocity: 0, full), .open(.end))
        XCTAssertEqual(PrototypeSwipe.settle(offset: -217, velocity: 0, plain), .open(.end))
        XCTAssertEqual(PrototypeSwipe.settle(offset: -170, velocity: -1800, full), .full(.end))
        XCTAssertEqual(PrototypeSwipe.settle(offset: -100, velocity: -1800, full), .open(.end))
        XCTAssertEqual(PrototypeSwipe.settle(offset: 217, velocity: 0, full), .full(.start))
    }

    func testRestOffsetsAreClosedTheRevealedWidthOrOffTheRow() {
        XCTAssertEqual(PrototypeSwipe.restOffset(.closed, plain), 0)
        XCTAssertEqual(PrototypeSwipe.restOffset(.open(.end), plain), -160)
        XCTAssertEqual(PrototypeSwipe.restOffset(.open(.start), plain), 80)
        XCTAssertEqual(PrototypeSwipe.restOffset(.full(.end), plain), -360)
    }

    func testTheEdgeButtonAbsorbsExtraRevealAndTheOthersKeepTheirWidth() {
        XCTAssertEqual(PrototypeSwipe.buttonWidths(count: 2, reveal: 160), [80, 80])
        XCTAssertEqual(PrototypeSwipe.buttonWidths(count: 2, reveal: 310), [230, 80])
        XCTAssertEqual(PrototypeSwipe.buttonWidths(count: 2, reveal: 40), [80, 80])
        XCTAssertEqual(PrototypeSwipe.buttonWidths(count: 0, reveal: 100), [])
    }

    func testOnlyAMostlyHorizontalDragIsASwipeAndVelocityUsesTheLastTwoSamples() {
        XCTAssertTrue(PrototypeSwipe.isHorizontal(translation: (x: 20, y: 5)))
        XCTAssertFalse(PrototypeSwipe.isHorizontal(translation: (x: 5, y: 20)))
        XCTAssertEqual(
            PrototypeSwipe.velocity([(time: 0, x: 0), (time: 0.1, x: -30), (time: 0.2, x: -80)]),
            -500,
            accuracy: 0.001
        )
        XCTAssertEqual(PrototypeSwipe.velocity([(time: 0, x: 0)]), 0)
        XCTAssertEqual(PrototypeSwipe.velocity([(time: 1, x: 0), (time: 1, x: 40)]), 0)
    }

    // MARK: One open row

    func testOpeningARowClosesThePreviouslyOpenOneAndOnlyOneIsOpen() throws {
        let first = try node(#"{"type":"row","children":[]}"#)
        let second = try node(#"{"type":"row","children":[]}"#)
        var coordinator = PrototypeSwipeCoordinator()
        XCTAssertNil(coordinator.opened(ObjectIdentifier(first)))
        XCTAssertEqual(coordinator.opened(ObjectIdentifier(second), side: .start), ObjectIdentifier(first))
        XCTAssertTrue(coordinator.isOpen(ObjectIdentifier(second)))
        XCTAssertFalse(coordinator.isOpen(ObjectIdentifier(first)))
        XCTAssertEqual(coordinator.openSide, .start)
        XCTAssertNil(coordinator.opened(ObjectIdentifier(second)))
        coordinator.closed(ObjectIdentifier(first))
        XCTAssertTrue(coordinator.isOpen(ObjectIdentifier(second)))
        coordinator.closed(ObjectIdentifier(second))
        XCTAssertNil(coordinator.openRow)
    }

    // MARK: Spec

    func testSwipeActionsDecodeAndExposeEntriesStartFirst() throws {
        let item = try node(#"""
        {"type":"listItem","headline":"Order","testTag":"order","swipeActions":{
          "start":[{"label":"Pin","icon":"favorite","onTap":[{"type":"emit","name":"pin"}]}],
          "end":[{"label":"Delete","role":"destructive","onTap":[{"type":"emit","name":"del"}]},
                 {"label":"Archive","color":"tertiary","onTap":[{"type":"emit","name":"arc"}]}],
          "fullSwipe":true}}
        """#)
        let swipe = try XCTUnwrap(item.swipeActions)
        XCTAssertEqual(swipe.entries.map(\.action.label), ["Pin", "Delete", "Archive"])
        XCTAssertEqual(swipe.entries.map(\.side), [.start, .end, .end])
        XCTAssertEqual(swipe.fullSwipe, true)
        XCTAssertEqual(PrototypeSwipe.Geometry(actions: swipe, rowWidth: 360).endWidth, 160)
        guard case let .swipeAction(second)? = item.tapTarget(identifier: "order.swipe.1", state: [:]) else {
            return XCTFail("no tap target")
        }
        XCTAssertEqual(second.label, "Delete")
        XCTAssertNil(item.tapTarget(identifier: "order.swipe.3", state: [:]))
    }

    func testARevealedButtonRunsItsActionsThroughTheSession() throws {
        let json = #"""
        {"id":"p","window":{"placement":{"type":"fullscreen"}},"state":{"gone":false},
         "root":{"type":"listItem","headline":"Order","testTag":"order","swipeActions":{
           "end":[{"label":"Delete","onTap":[{"type":"setState","key":"gone","value":true},{"type":"emit","name":"del"}]}]}}}
        """#
        var session = PrototypeSession()
        try session.show(JSONDecoder().decode(PrototypeSpec.self, from: Data(json.utf8)))
        let target = try XCTUnwrap(session.spec?.root.tapTarget(identifier: "order.swipe.0", state: session.state))
        let events = try XCTUnwrap(session.activate(target))
        XCTAssertEqual(session.state["gone"], .bool(true))
        XCTAssertTrue(events.contains { $0.name == "del" })
    }

    private func swipeTarget(_ session: PrototypeSession, row: Int, button: Int) -> PrototypeTapTarget? {
        guard let item = session.spec?.root.children?[row], let tag = item.testTag else { return nil }
        return item.tapTarget(identifier: "\(tag).swipe.\(button)", state: session.state)
    }

    func testASwipeButtonRunsDataAndRequestActionsInsideARepeat() throws {
        let json = #"""
        {"id":"p","window":{"placement":{"type":"fullscreen"}},"state":{"status":"idle"},
         "data":{"items":[{"id":"a"},{"id":"b"}]},
         "root":{"type":"column","repeat":{"items":{"path":"/items"},"as":"o"},"children":[
           {"type":"listItem","headline":"{o.id}","testTag":"row{index}","swipeActions":{"end":[
             {"label":"Remove","onTap":[{"type":"removeData","path":"/data/items/{index}"}]},
             {"label":"Sync","onTap":[{"type":"request","url":"http://h.test/{o.id}","into":"/data/last",
               "statusKey":"status"}]}]}}]}}
        """#
        var session = PrototypeSession()
        try session.show(JSONDecoder().decode(PrototypeSpec.self, from: Data(json.utf8)))
        // The request inside the swipe action is validated at show and runs its start command.
        let sync = try XCTUnwrap(swipeTarget(session, row: 1, button: 1))
        XCTAssertNotNil(session.activate(sync))
        guard case let .start(job)? = session.takeRequestCommands().first else { return XCTFail("no request") }
        XCTAssertEqual(job.url, "http://h.test/b")
        XCTAssertEqual(session.state["status"], .string("loading"))
        // A data action in a swipe button changes /data and rebuilds the drawn rows.
        let remove = try XCTUnwrap(swipeTarget(session, row: 0, button: 0))
        XCTAssertNotNil(session.activate(remove))
        XCTAssertEqual(session.data?["items"], .array([.object(["id": .string("b")])]))
    }

    func testASwipeButtonWithAnInvalidRequestFailsTheShowAtItsPath() throws {
        let json = #"""
        {"id":"p","window":{"placement":{"type":"fullscreen"}},
         "root":{"type":"listItem","headline":"x","swipeActions":{"end":[
           {"label":"Go","onTap":[{"type":"request","url":"ftp://h/x"}]}]}}}
        """#
        XCTAssertThrowsError(try JSONDecoder().decode(PrototypeSpec.self, from: Data(json.utf8))) { error in
            XCTAssertTrue("\(error)".contains("root.swipeActions.end[0].onTap[0]"), "\(error)")
        }
    }

    func testSharedValidFixturesDecode() throws {
        for name in ["swipe-actions-list-item", "swipe-actions-row", "swipe-actions-vertical-pager"] {
            let spec = try JSONDecoder().decode(
                PrototypeSpec.self,
                from: Data(contentsOf: fixtures.appendingPathComponent("valid/\(name).json"))
            )
            XCTAssertFalse(spec.root.type.isEmpty, name)
        }
    }

    func testSharedInvalidFixturesFailAtTheirPathWhereTheAgentChecksThem() throws {
        // The agent checks the side and the horizontal pager/carousel rule; the rest is the host's.
        let names = [
            "swipe-actions-empty", "swipe-actions-in-horizontal-pager", "swipe-actions-in-carousel",
        ]
        for name in names {
            let data = try Data(contentsOf: fixtures.appendingPathComponent("invalid/\(name).json"))
            let fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            let expected = try XCTUnwrap(fixture["expectedPath"] as? String)
            let spec = try JSONSerialization.data(withJSONObject: XCTUnwrap(fixture["spec"]))
            XCTAssertThrowsError(try JSONDecoder().decode(PrototypeSpec.self, from: spec), name) { error in
                XCTAssertTrue("\(error)".contains("\(expected):"), "\(name): \(error)")
            }
        }
    }

    func testRepeatInstancesBindSwipeLabelsAndActions() throws {
        let tree = JSONValue.object([
            "type": .string("column"),
            "repeat": .object(["as": .string("o"), "items": .array([.object(["id": .string("a")])])]),
            "children": .array([.object([
                "type": .string("listItem"), "headline": .string("x"),
                "swipeActions": .object(["end": .array([.object([
                    "label": .string("Del {o.id}"),
                    "onTap": .array([.object(["type": .string("emit"), "name": .string("del_{o.id}")])]),
                ])])]),
            ])]),
        ])
        guard case let .object(expanded) = PrototypeRepeat.expand(tree),
              case let .array(children)? = expanded["children"], case let .object(item)? = children.first,
              case let .object(swipe)? = item["swipeActions"], case let .array(end)? = swipe["end"],
              case let .object(entry)? = end.first, case let .array(taps)? = entry["onTap"],
              case let .object(tap)? = taps.first
        else { return XCTFail("not expanded") }
        XCTAssertEqual(entry["label"], .string("Del a"))
        XCTAssertEqual(tap["name"], .string("del_a"))
    }

    func testTheAgentAdvertisesSwipeActions() {
        XCTAssertTrue(PrototypeAgentProtocol.capabilities.contains("prototype_swipe_actions_v1"))
        XCTAssertEqual(PrototypeAgentProtocol.swipeActionsCapability, "prototype_swipe_actions_v1")
    }
}
