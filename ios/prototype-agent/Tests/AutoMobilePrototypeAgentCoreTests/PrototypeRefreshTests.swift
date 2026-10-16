@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeRefreshTests: XCTestCase {
    private func spec(_ json: String) throws -> PrototypeSpec {
        try JSONDecoder().decode(PrototypeSpec.self, from: Data(json.utf8))
    }

    private func scroll(_ extra: String = "", state: String = #"{"busy":false}"#) -> String {
        """
        {"id":"p","window":{"placement":{"type":"fullscreen"}},"state":\(state),
         "root":{"type":"scroll",\(extra)"refresh":{"stateKey":"busy","onRefresh":[{"type":"emit","name":"reload"}]},
         "child":{"type":"text","text":"x"}}}
        """
    }

    func testRefreshDecodesWithItsKeyAndActions() throws {
        let refresh = try XCTUnwrap(spec(scroll()).root.refresh)
        XCTAssertEqual(refresh.stateKey, "busy")
        XCTAssertEqual(refresh.onRefresh.map(\.type), ["emit"])
        XCTAssertEqual(refresh.onRefresh.first?.name, "reload")
    }

    func testAPullSetsTheKeyBeforeRunningTheAuthoredActions() throws {
        let refresh = try XCTUnwrap(spec(scroll()).root.refresh)
        let actions = PrototypeRefresh.actions(for: refresh)
        XCTAssertEqual(actions.map(\.type), ["setState", "emit"])
        XCTAssertEqual(actions.first?.key, "busy")
        XCTAssertEqual(actions.first?.value, .bool(true))
        var session = PrototypeSession()
        try session.show(spec(scroll()))
        let events = session.run(actions)
        XCTAssertEqual(session.state["busy"], .bool(true))
        XCTAssertEqual(Set(events.compactMap(\.name)), ["change", "reload"])
        let clear = try JSONDecoder().decode(
            PrototypeAction.self, from: Data(#"{"type":"setState","key":"busy","value":false}"#.utf8)
        )
        _ = session.run([clear])
        XCTAssertEqual(session.state["busy"], .bool(false))
    }

    func testAHorizontalScrollWithRefreshIsRefusedAtTheRefreshPath() {
        XCTAssertThrowsError(try spec(scroll(#""axis":"horizontal","#))) { error in
            XCTAssertTrue("\(error)".contains("root.refresh: Pull-to-refresh needs a vertical scroll"), "\(error)")
        }
        XCTAssertNoThrow(try spec(scroll(#""axis":"vertical","#)))
    }

    func testANonBooleanDeclaredKeyIsRejected() throws {
        let decoded = try spec(scroll(state: #"{"busy":"yes"}"#))
        XCTAssertEqual(
            PrototypeStateValidator.rejection(root: decoded.root, state: decoded.state ?? [:]),
            "Refresh requires a boolean state key"
        )
        let good = try spec(scroll())
        XCTAssertNil(PrototypeStateValidator.rejection(root: good.root, state: good.state ?? [:]))
    }

    func testRepeatInstancesBindTheKeyAndActions() throws {
        let tree = JSONValue.object([
            "type": .string("column"),
            "repeat": .object(["as": .string("item"), "items": .array([.object(["id": .string("a")])])]),
            "children": .array([.object([
                "type": .string("scroll"),
                "refresh": .object([
                    "stateKey": .string("busy_{item.id}"),
                    "onRefresh": .array([.object(["type": .string("emit"), "name": .string("reload_{item.id}")])]),
                ]),
                "child": .object(["type": .string("text"), "text": .string("x")]),
            ])]),
        ])
        guard case let .object(expanded) = PrototypeRepeat.expand(tree),
              case let .array(children)? = expanded["children"],
              case let .object(scroll)? = children.first,
              case let .object(refresh)? = scroll["refresh"],
              case let .array(actions)? = refresh["onRefresh"],
              case let .object(emit)? = actions.first
        else { return XCTFail("not expanded") }
        XCTAssertEqual(refresh["stateKey"], .string("busy_a"))
        XCTAssertEqual(emit["name"], .string("reload_a"))
    }

    @MainActor
    func testTheRefreshableClosureStaysOpenUntilTheKeyClears() async {
        var polls = 0
        var sleeps = 0
        await PrototypeRefresh.awaitCompletion(
            isRefreshing: { polls += 1; return polls <= 3 },
            isCancelled: { false },
            sleep: { sleeps += 1 }
        )
        XCTAssertEqual(sleeps, 3)
        var cancelledSleeps = 0
        await PrototypeRefresh.awaitCompletion(
            isRefreshing: { true },
            isCancelled: { cancelledSleeps >= 2 },
            sleep: { cancelledSleeps += 1 }
        )
        XCTAssertEqual(cancelledSleeps, 2)
    }

    func testTheSharedFixtureDecodes() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test/fixtures/prototype-spec/valid/scroll-refresh.json")
        let decoded = try JSONDecoder().decode(PrototypeSpec.self, from: Data(contentsOf: url))
        XCTAssertEqual(decoded.root.refresh?.stateKey, "refreshing")
    }
}
