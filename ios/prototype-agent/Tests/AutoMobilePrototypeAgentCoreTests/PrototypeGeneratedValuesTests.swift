@testable import AutoMobilePrototypeAgentCore
import XCTest

final class SeededPrototypeIds: PrototypeIdGenerator {
    private var ids: [String]
    private(set) var calls = 0
    init(_ ids: [String] = ["id-1", "id-2"]) { self.ids = ids }
    func next() -> String {
        calls += 1
        return ids.removeFirst()
    }
}

struct FakePrototypeEpochClock: PrototypeEpochClock {
    let milliseconds: Int64
    func nowEpochMs() -> Int64 { milliseconds }
}

final class PrototypeGeneratedValuesTests: XCTestCase {
    struct Fixture: Decodable {
        let name: String
        let initialData: [String: JSONValue]
        let ids: [String]
        let clockMs: Int64
        let actions: [JSONValue]
        let mockResponses: [JSONValue]
        let expected: JSONValue

        func spec() throws -> Data {
            try JSONEncoder().encode(JSONValue.object([
                "id": .string("generated"),
                "window": .object(["placement": .object(["type": .string("fullscreen")])]),
                "data": .object(initialData),
                "root": .object(["type": .string("button"), "label": .string("Send"), "onTap": .array(actions)]),
            ]))
        }
    }

    static func fixtures() throws -> [Fixture] {
        try JSONDecoder().decode([Fixture].self, from: Data(
            contentsOf:
            PrototypeSpecFixtures.directory.appendingPathComponent("data/generated-values.json")
        ))
    }

    private struct Inputs: PrototypeEmitContextInputs {
        let values: [String: JSONValue]
        func state(_: String) -> JSONValue? { nil }
        func page(_: String) -> Int? { nil }
        func data(_ pointer: String) -> JSONValue? { PrototypeDataPointer.resolve(values, pointer: pointer) }
    }

    /// Pure fixture runner exposes the typed refusal that the session intentionally handles as a no-op.
    private func apply(_ fixture: Fixture) throws -> (JSONValue, String?) {
        var data = fixture.initialData
        var errorCode: String?
        let context = PrototypeActionContext(
            ids: SeededPrototypeIds(fixture.ids),
            clock: FakePrototypeEpochClock(milliseconds: fixture.clockMs)
        )
        var pending: [(PrototypeAction, PrototypeResolvedRequest, PrototypeActionContext)] = []
        func run(_ rawActions: [JSONValue], _ context: PrototypeActionContext) throws {
            for raw in rawActions {
                let action = try JSONDecoder().decode(PrototypeAction.self, from: JSONEncoder().encode(raw))
                let inputs = Inputs(values: data)
                if action.type == "request" {
                    let request = try PrototypeRequestResolver.resolve(
                        action,
                        urlText: PrototypeRequestResolver.urlText(action, inputs: inputs),
                        inputs: inputs,
                        context: context
                    ).get()
                    pending.append((action, request, context.copy()))
                    continue
                }
                let operation = try XCTUnwrap(PrototypeDataWrite.Operation(actionType: action.type))
                var value: JSONValue?
                if operation != .remove {
                    value = try PrototypeDataWrite.resolveValue(action.value, inputs: inputs, context: context).get()
                }
                let match = try action.where.map {
                    try PrototypeDataWrite.Match(
                        field: $0.field,
                        equals: PrototypeDataWrite.resolveValue($0.equals, inputs: inputs, context: context).get()
                    )
                }
                data = try PrototypeDataWrite.apply(
                    data,
                    op: operation,
                    path: XCTUnwrap(action.path),
                    value: value,
                    where: match,
                    member: action.member
                ).get()
            }
        }
        do {
            try run(fixture.actions, context)
            for (index, response) in fixture.mockResponses.enumerated() {
                let (action, request, captured) = pending[index]
                let fields = try XCTUnwrap(response.objectFields)
                let outcome = PrototypeRequestOutcome.apply(
                    data,
                    into: action.into,
                    response: .received(
                        status: Int(fields["status"]?.numberValue ?? 200),
                        headers: [:],
                        body: fields["body"] ?? .null,
                        durationMs: 0
                    ),
                    where: request.where,
                    member: action.member
                )
                data = outcome.data
                errorCode = outcome.meta.error?.code.rawValue
                // Locate the request independently of its position among preceding writes.
                let requestRaw = fixture.actions.first { $0.objectFields?["type"] == .string("request") }
                let callbacks = rawList(requestRaw, outcome.status == "success" ? "onSuccess" : "onError")
                try run(callbacks, captured)
            }
        } catch let failure as PrototypeDataWriteFailure { errorCode = failure.code.rawValue }
        return (.object(data), errorCode)
    }

    private func rawList(_ value: JSONValue?, _ key: String) -> [JSONValue] {
        PrototypeStrictBindings.array(value?.objectFields?[key])
    }

    func testEverySharedFixture() throws {
        for fixture in try Self.fixtures() {
            let (data, error) = try apply(fixture)
            if let expected = fixture.expected.objectFields?["data"] { XCTAssertEqual(data, expected, fixture.name) }
            if let expected = fixture.expected.objectFields?["errorCode"]?.stringValue {
                XCTAssertEqual(error, expected, fixture.name)
            }
        }
    }

    func testFixtureValidationAndCapabilities() throws {
        for fixture in try Self.fixtures() {
            let bytes = try fixture.spec()
            if fixture.expected.objectFields?["errorCode"] == .string("lastGenerated_unset") {
                XCTAssertThrowsError(try PrototypeSpecStrictValidator.validate(data: bytes)) {
                    XCTAssertTrue(String(describing: $0).contains("lastGenerated_unset"))
                }
                continue
            }
            XCTAssertNoThrow(try PrototypeSpecStrictValidator.validate(data: bytes), fixture.name)
            let required = try Set(PrototypeBundleCapabilities.required(bytes))
            XCTAssertTrue(required.contains("prototype_data_actions_v2"), fixture.name)
            XCTAssertThrowsError(try PrototypeSpecStrictValidator.validate(
                data: bytes,
                supportedCapabilities: required.subtracting(["prototype_data_actions_v2"])
            ), fixture.name)
        }
    }

    func testRuntimeCapturesCallbacksAndEmitsResolvedValues() throws {
        for fixture in try Self.fixtures() where fixture.expected.objectFields?["data"] != nil {
            let ids = SeededPrototypeIds(fixture.ids)
            var session = PrototypeSession(
                idGenerator: ids,
                generatedClock: FakePrototypeEpochClock(milliseconds: fixture.clockMs)
            )
            let spec = try JSONDecoder().decode(PrototypeSpec.self, from: fixture.spec())
            session.show(spec)
            let events = session.run(spec.root.onTap ?? [])
            let generatedCalls = ids.calls
            for event in events where event.wireKind == "change" && event.name == "/data/rows" {
                let write = try XCTUnwrap(PrototypeDataWriteEvent.decode(
                    kind: event.wireKind,
                    name: event.name,
                    payload: event.payload
                ))
                XCTAssertEqual(write.payload, event.payload)
                if write.op == .append { XCTAssertNotNil(write.value?.objectFields?["id"]?.stringValue) }
            }
            XCTAssertEqual(ids.calls, generatedCalls)
            let jobs = session.takeRequestCommands().compactMap { command -> PrototypeRequestJob? in
                if case let .start(job) = command { return job }; return nil
            }
            for (job, raw) in zip(jobs, fixture.mockResponses) {
                let fields = try XCTUnwrap(raw.objectFields)
                _ = session.completeRequest(job.requestId, .received(
                    status: Int(fields["status"]?.numberValue ?? 200),
                    headers: [:],
                    body: fields["body"] ?? .null,
                    durationMs: 0
                ))
            }
            XCTAssertEqual(JSONValue.object(session.data ?? [:]), fixture.expected.objectFields?["data"], fixture.name)
            XCTAssertEqual(ids.calls, generatedCalls)
        }
    }

    func testStaticScopesAndSecureSelectors() throws {
        func spec(_ actions: String) -> Data {
            Data("""
            {"id":"scope","window":{"placement":{"type":"fullscreen"}},"data":{"rows":[]},
             "root":{"type":"button","label":"Send","onTap":\(actions)}}
            """.utf8)
        }
        let invalid = [
            #"[{"type":"request","url":"https://example.test","onSuccess":[{"type":"setData","path":"/data/id","value":{"lastGenerated":true}}]},{"type":"setData","path":"/data/id","value":{"generate":"id"}}]"#,
            #"[{"type":"request","url":"https://example.test","onSuccess":[{"type":"setData","path":"/data/id","value":{"generate":"id"}}]},{"type":"setData","path":"/data/id","value":{"lastGenerated":true}}]"#,
            #"[{"type":"setData","path":"/data/id","value":{"value":{"a":{"lastGenerated":true},"z":{"generate":"id"}}}}]"#,
        ]
        for actions in invalid {
            XCTAssertThrowsError(try PrototypeSpecStrictValidator.validate(data: spec(actions))) {
                XCTAssertTrue(String(describing: $0).contains("lastGenerated_unset"))
            }
        }
        let secure = ["state:token"]
        for type in ["setData", "removeData", "request"] {
            let raw: [String: JSONValue] = [
                "type": .string(type),
                "where": .object(["field": .string("id"), "equals": .object(["state": .string("token")])]),
            ]
            if type == "request" {
                XCTAssertThrowsError(try PrototypeSecureStorageRules.validateRequest(
                    raw,
                    path: "action",
                    secure: secure
                ))
                var allowed = raw
                allowed["allowSecureInRequest"] = .bool(true)
                XCTAssertNoThrow(try PrototypeSecureStorageRules.validateRequest(
                    allowed,
                    path: "action",
                    secure: secure
                ))
            } else {
                XCTAssertThrowsError(try PrototypeSecureStorageRules.validateDataAction(
                    raw,
                    path: "action",
                    secure: secure
                ))
                XCTAssertThrowsError(try PrototypeSecureStorageRules.validateDataAction([
                    "type": .string(type), "value": .object(["state": .string("token")]),
                ], path: "action", secure: secure))
            }
            for binding: JSONValue in [
                .object(["generate": .string("id")]),
                .object(["now": .string("iso")]),
                .object(["lastGenerated": .bool(true)]),
            ] {
                var safe = raw
                safe["where"] = .object(["field": .string("id"), "equals": binding])
                XCTAssertNoThrow(try PrototypeSecureStorageRules.validateDataAction(
                    safe,
                    path: "action",
                    secure: secure
                ))
                XCTAssertNoThrow(try PrototypeSecureStorageRules.validateRequest(safe, path: "action", secure: secure))
            }
        }
    }

    func testRequestBindingsResolveOnceInDispatchOrder() throws {
        let raw =
            #"{"type":"request","url":"https://example.test","method":"POST","headers":{"x-id":{"generate":"id"}},"query":{"at":{"now":"epochMs"}},"body":{"lastGenerated":true},"into":"/data/rows","where":{"field":"id","equals":{"lastGenerated":true}},"member":"result"}"#
        let action = try JSONDecoder().decode(PrototypeAction.self, from: Data(raw.utf8))
        let ids = SeededPrototypeIds()
        let context = PrototypeActionContext(ids: ids, clock: FakePrototypeEpochClock(milliseconds: 1_700_000_000_000))
        let resolved = try PrototypeRequestResolver.resolve(
            action,
            urlText: action.url ?? "",
            inputs: Inputs(values: [:]),
            context: context
        ).get()
        XCTAssertEqual(resolved.headers, ["x-id": "id-1"])
        XCTAssertTrue(resolved.url.contains("at=1700000000000"))
        XCTAssertEqual(resolved.body, .string("id-1"))
        XCTAssertEqual(resolved.where, .init(field: "id", equals: .string("id-1")))
        XCTAssertEqual(ids.calls, 1)
        let bound = try PrototypeRepeatInstance(alias: "row", item: ["id": .string("row-id")], index: 2).bindAction(
            JSONDecoder().decode(JSONValue.self, from: Data(raw.replacingOccurrences(
                of: #""equals":{"lastGenerated":true}"#, with: #""equals":{"item":"id"}"#
            ).utf8)))
        XCTAssertEqual(bound.objectFields?["where"]?.objectFields?["equals"], .object(["value": .string("row-id")]))
    }

    func testGeneratedStateAndSeparateInvocations() throws {
        let bytes =
            Data(
                #"{"id":"state","window":{"placement":{"type":"fullscreen"}},"state":{"id":"","at":0},"root":{"type":"button","label":"Go","onTap":[{"type":"setState","key":"id","value":{"generate":"id"}},{"type":"setState","key":"at","value":{"now":"epochMs"}}]}}"#
                    .utf8
            )
        XCTAssertNoThrow(try PrototypeSpecStrictValidator.validate(data: bytes))
        let spec = try JSONDecoder().decode(PrototypeSpec.self, from: bytes)
        var session = PrototypeSession(
            idGenerator: SeededPrototypeIds(),
            generatedClock: FakePrototypeEpochClock(milliseconds: 42)
        )
        session.show(spec)
        _ = session.run(spec.root.onTap ?? [])
        XCTAssertEqual(session.state["id"], .string("id-1"))
        XCTAssertEqual(session.state["at"], .number(42))
        let read = try JSONDecoder().decode(
            [PrototypeAction].self,
            from: Data(#"[{"type":"setState","key":"id","value":{"lastGenerated":true}}]"#.utf8)
        )
        XCTAssertTrue(session.run(read).isEmpty)
        XCTAssertEqual(session.state["id"], .string("id-1"))
    }

    func testExactMarkersAndUTF16EvaluationOrder() throws {
        let ids = SeededPrototypeIds()
        let context = PrototypeActionContext(ids: ids, clock: FakePrototypeEpochClock(milliseconds: 1_700_000_000_001))
        let raw = try JSONDecoder().decode(
            JSONValue.self,
            from: Data(
                #"{"value":{"b":{"lastGenerated":true},"a":{"generate":"id"},"iso":{"now":"iso"},"opaque":{"generate":"id","extra":true}}}"#
                    .utf8
            )
        )
        let result = try XCTUnwrap(PrototypeGeneratedValues.resolveBinding(raw, context: context)).get()
        XCTAssertEqual(result.objectFields?["a"], .string("id-1"))
        XCTAssertEqual(result.objectFields?["b"], .string("id-1"))
        XCTAssertEqual(result.objectFields?["iso"], .string("2023-11-14T22:13:20.001Z"))
        XCTAssertEqual(result.objectFields?["opaque"], raw.objectFields?["value"]?.objectFields?["opaque"])
        XCTAssertEqual(ids.calls, 1)
    }
}

@MainActor
final class PrototypeGeneratedRequestDriverTests: XCTestCase {
    func testGeneratedWriteRequestAndSuccessThroughHTTPSeam() async throws {
        let fixture = try XCTUnwrap(
            PrototypeGeneratedValuesTests.fixtures()
                .first { $0.name.contains("success captures") }
        )
        let harness = RequestHarness()
        harness.session = PrototypeSession(
            idGenerator: SeededPrototypeIds(fixture.ids),
            generatedClock: FakePrototypeEpochClock(milliseconds: fixture.clockMs)
        )
        let spec = try JSONDecoder().decode(PrototypeSpec.self, from: fixture.spec())
        harness.session.show(spec)
        harness.driver.updateClients(device: harness.client, hostRoute: .handler(harness.client))
        harness.tap()
        await harness.waitForDeviceCalls(1)
        XCTAssertEqual(harness.client.requests.count, 1)
        harness.client.respond(0, status: 200, body: "{}", durationMs: 0)
        await harness.driver.settled()
        XCTAssertEqual(JSONValue.object(harness.session.data ?? [:]), fixture.expected.objectFields?["data"])
    }
}
