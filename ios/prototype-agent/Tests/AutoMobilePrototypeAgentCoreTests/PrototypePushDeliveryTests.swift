@testable import AutoMobilePrototypeAgentCore
import Foundation
import XCTest

/// The push delivery (#14285) replays `push/traces.json`, the traces the TypeScript reference and the
/// Kotlin twin replay: each step applies the handler's data and state writes with `{event}` read from
/// the push, then checks `/data`, state, the delivered event and the alert.
final class PrototypePushDeliveryTests: XCTestCase {
    private var traces: [JSONValue] {
        get throws {
            let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
                .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
                .appendingPathComponent("test/fixtures/prototype-spec/push/traces.json")
            guard case let .array(traces) = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url))
            else { throw XCTSkip("traces.json is not an array") }
            return traces
        }
    }

    private struct Inputs: PrototypeEmitContextInputs {
        let stateValues: [String: JSONValue]
        let dataValues: [String: JSONValue]
        let push: [String: JSONValue]
        func state(_ key: String) -> JSONValue? { stateValues[key] }
        func page(_: String) -> Int? { nil }
        func data(_ pointer: String) -> JSONValue? { PrototypeDataPointer.resolve(dataValues, pointer: pointer) }
        func event(_ pointer: String) -> JSONValue? { PrototypeDataPointer.resolve(push, pointer: pointer) }
    }

    /// The traces' handlers use only `appendData` and `setState`.
    private func apply(
        _ action: [String: JSONValue], push: [String: JSONValue], data: inout [String: JSONValue],
        state: inout [String: JSONValue]
    ) throws {
        let inputs = Inputs(stateValues: state, dataValues: data, push: push)
        let value = try PrototypeDataWrite.resolveValue(action["value"], inputs: inputs).get()
        switch action["type"]?.stringValue {
        case "setState":
            let key = try XCTUnwrap(action["key"]?.stringValue)
            state[key] = value
        case "appendData":
            let path = try XCTUnwrap(action["path"]?.stringValue)
            data = try PrototypeDataWrite.apply(data, op: .append, path: path, value: value).get()
        default:
            XCTFail("Unexpected handler action \(action["type"] ?? .null)")
        }
    }

    private func handler(of spec: [String: JSONValue]) -> [JSONValue]? {
        let handlers = spec["platform"]?.objectFields?["on"]?.objectFields
        guard case let .array(actions)? = handlers?[PrototypePushDelivery.event] else { return nil }
        return actions
    }

    func testSharedPushTraces() throws {
        let traces = try traces
        XCTAssertFalse(traces.isEmpty)
        for raw in traces {
            let trace = try XCTUnwrap(raw.objectFields)
            let name = trace["name"]?.stringValue ?? "unnamed"
            let spec = try XCTUnwrap(trace["spec"]?.objectFields)
            let actions = handler(of: spec)
            var data = spec["data"]?.objectFields ?? [:]
            var state = spec["state"]?.objectFields ?? [:]
            guard case let .array(steps)? = trace["steps"] else { return XCTFail("\(name): expected steps") }
            for (index, rawStep) in steps.enumerated() {
                let step = try XCTUnwrap(rawStep.objectFields)
                let push = try XCTUnwrap(step["push"]?.objectFields)
                for action in actions ?? [] {
                    try apply(XCTUnwrap(action.objectFields), push: push, data: &data, state: &state)
                }
                let expect = try XCTUnwrap(step["expect"]?.objectFields)
                XCTAssertEqual(JSONValue.object(data), expect["data"], "\(name) step \(index) data")
                XCTAssertEqual(JSONValue.object(state), expect["state"], "\(name) step \(index) state")
                // The traces push over the live connection to a foreground prototype.
                let outcome = PrototypePushDelivery.deliver(
                    handled: actions != nil, payload: push, appState: "active", route: .connection
                )
                let delivered = JSONValue.object([
                    "kind": .string("emit"), "name": .string("prototype_platform_event"), "payload": outcome.event,
                ])
                XCTAssertEqual(JSONValue.array([delivered]), expect["events"], "\(name) step \(index) event")
                XCTAssertEqual(outcome.alert, actions == nil ? push["notification"] : nil, "\(name) step \(index)")
            }
        }
    }

    func testUnhandledTracePostsItsNotificationAsAnAlert() throws {
        let trace = try XCTUnwrap(traces.compactMap(\.objectFields).first {
            $0["name"] == .string("an unhandled push with a notification changes no data")
        })
        guard case let .array(steps)? = trace["steps"], let push = steps.first?.objectFields?["push"]?.objectFields
        else { return XCTFail("Expected one step") }
        let outcome = PrototypePushDelivery.deliver(
            handled: false, payload: push, appState: "active", route: .connection
        )
        let expected = JSONValue.object(["title": .string("Ada"), "body": .string("Hi"), "channel": .string("chat")])
        XCTAssertEqual(outcome.alert, expected)
    }

    func testConnectionIsForegroundOnlyWhileActiveAndSystemIsNotification() {
        let states = ["active", "inactive", "background"]
        XCTAssertEqual(
            states.map { PrototypePushDelivery.delivery(route: .connection, appState: $0) },
            ["foreground", "background", "background"]
        )
        XCTAssertEqual(
            states.map { PrototypePushDelivery.delivery(route: .system, appState: $0) },
            ["notification", "notification", "notification"]
        )
    }

    func testHandledPushOrOneWithoutNotificationPostsNoAlert() {
        let notification = JSONValue.object(["title": .string("Ada")])
        let withAlert: [String: JSONValue] = [
            "type": .string("message"), "data": .object([:]), "notification": notification,
        ]
        let plain: [String: JSONValue] = ["type": .string("message"), "data": .object([:])]
        XCTAssertNil(
            PrototypePushDelivery.deliver(handled: true, payload: withAlert, appState: "active", route: .connection)
                .alert
        )
        XCTAssertNil(
            PrototypePushDelivery.deliver(handled: false, payload: plain, appState: "background", route: .system).alert
        )
        XCTAssertEqual(
            PrototypePushDelivery.deliver(handled: false, payload: withAlert, appState: "inactive", route: .system)
                .alert,
            notification
        )
    }
}
