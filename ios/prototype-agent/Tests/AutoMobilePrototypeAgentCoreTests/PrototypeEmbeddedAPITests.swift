@testable import AutoMobilePrototypeAgentCore
import Foundation
import XCTest

@MainActor
final class PrototypeEmbeddedAPITests: XCTestCase {
    private var repository: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    }

    private func fixture(_ name: String) throws -> Data {
        try Data(contentsOf: repository.appendingPathComponent("test/fixtures/" + name))
    }

    private actor Client {
        private(set) var calls: [URLRequest] = []
        func perform(_ request: URLRequest) throws -> (Data, HTTPURLResponse) {
            calls.append(request)
            let response = try XCTUnwrap(HTTPURLResponse(
                url: XCTUnwrap(request.url), statusCode: 200, httpVersion: nil, headerFields: ["X-Test": "yes"]
            ))
            return (Data(#""ok""#.utf8), response)
        }
    }

    private struct RoutingCase: Decodable {
        let name: String
        let via: String?
        let hostHandler: Bool
        let expectedRoute: String
    }

    func testPublicConfigurationRoutesSharedFixtureThroughFakeClientsAndMapsRequestEvents() async throws {
        let cases = try JSONDecoder().decode(
            [RoutingCase].self,
            from: fixture("prototype-embedded-routing/routing.json")
        )
        XCTAssertEqual(cases.count, 5)
        for testCase in cases {
            let device = Client()
            let handler = Client()
            let handlerClosure: PrototypeNetworkConfiguration.Client?
            if testCase.hostHandler {
                handlerClosure = { try await handler.perform($0) }
            } else {
                handlerClosure = nil
            }
            let configuration = PrototypeNetworkConfiguration(
                deviceClient: { try await device.perform($0) }, hostHandler: handlerClosure
            )
            let via = testCase.via.map { #", "via":"\#($0)""# } ?? ""
            let data = Data("""
            {"id":"embedded","window":{"placement":{"type":"fullscreen"}},"state":{"status":"idle"},"data":{},
             "root":{"type":"button","label":"Go","onTap":[{"type":"request","url":"https://example.test/feed",
             "into":"/data/feed","statusKey":"status"\(via)}]}}
            """.utf8)
            let loaded = try PrototypeEmbeddedSpec.load(data: data)
            let driver = configuration.driver(clock: ManualRequestClock())
            var session = PrototypeSession()
            session.show(loaded.spec)
            var events: [PrototypeEvent] = []
            driver.onComplete = { id, response in
                events += session.completeRequest(id, response)
            }
            _ = session.run(loaded.spec.root.onTap ?? [])
            driver.perform(session.takeRequestCommands())
            await driver.settled()
            let deviceCalls = await device.calls
            let handlerCalls = await handler.calls
            XCTAssertEqual(deviceCalls.count, testCase.expectedRoute == "device" ? 1 : 0, testCase.name)
            XCTAssertEqual(handlerCalls.count, testCase.expectedRoute == "handler" ? 1 : 0, testCase.name)
            let requestEvent = try XCTUnwrap(events.first { $0.name == PrototypeRequestEvent.name })
            let mapped = try PrototypeEvent(wire: requestEvent.wireObject(timestamp: 123))
            XCTAssertEqual(mapped.type, .request)
            let payload = try JSONDecoder().decode([String: JSONValue].self, from: mapped.payloadJSON)
            XCTAssertEqual(payload["outcome"], .string("success"))
            XCTAssertEqual(payload["via"], .string(testCase.via ?? "host"))
            XCTAssertEqual(payload["status"], .number(200))
            XCTAssertTrue(events.contains { $0.type == .dataWrite })
            XCTAssertEqual(session.state["status"], .string("success"))
        }
    }

    func testMapsRealTapSubmitStateDataWriteAndDismissWireEvents() throws {
        // Existing shared fixture: trailing-icon tap changes state; onSubmit emits `search`.
        let data = try fixture("prototype-spec/valid/text-field-actions.json")
        let loaded = try PrototypeEmbeddedSpec.load(data: data)
        let field = try XCTUnwrap(loaded.spec.root.children?.first)
        var session = PrototypeSession()
        session.show(loaded.spec)
        let tap = try XCTUnwrap(field.trailingIcon?.onTap)
        let change = try XCTUnwrap(session.run(tap).first)
        let mappedChange = try PrototypeEvent(wire: change.wireObject(timestamp: 1))
        XCTAssertEqual(mappedChange.type, .change)
        XCTAssertEqual(mappedChange.name, "change")
        XCTAssertEqual(
            try JSONDecoder().decode([String: JSONValue].self, from: mappedChange.stateJSON)["query"],
            .string("")
        )
        let submit = try XCTUnwrap(session.run(field.onSubmit ?? []).first)
        let mappedSubmit = try PrototypeEvent(wire: submit.wireObject(timestamp: 2))
        XCTAssertEqual(mappedSubmit.type, .emitted)
        XCTAssertEqual(mappedSubmit.name, "search") // Submit does not invent a separate kind.

        // Existing shared data-actions fixture supplies the exact action value wrapper.
        let spec = try PrototypeEmbeddedSpec.load(data: fixture("prototype-spec/valid/data-actions-list.json")).spec
        session.show(spec)
        let add = try XCTUnwrap(spec.root.children?.first?.onTap)
        let write = try XCTUnwrap(session.run(add).first)
        let mappedWrite = try PrototypeEvent(wire: write.wireObject(timestamp: 3))
        XCTAssertEqual(mappedWrite.type, .dataWrite)
        XCTAssertEqual(mappedWrite.name, "/data/items")
        XCTAssertEqual(
            try JSONDecoder().decode([String: JSONValue].self, from: mappedWrite.payloadJSON)["op"],
            .string("append")
        )
        let dismiss = try XCTUnwrap(session.dismiss(reason: .user).first)
        let mappedDismiss = try PrototypeEvent(wire: dismiss.wireObject(timestamp: 4))
        XCTAssertEqual(mappedDismiss.type, .dismissed)
        XCTAssertEqual(mappedDismiss.dismissReason, .user)
    }

    func testUnknownKindRetainsCompleteWireIncludingFutureFields() throws {
        let loaded = try PrototypeEmbeddedSpec.load(data: fixture("prototype-spec/valid/text-field-actions.json"))
        var session = PrototypeSession()
        session.show(loaded.spec)
        let event = try XCTUnwrap(session.dismiss(reason: .agent).first)
        var wire = event.wireObject(timestamp: 456)
        wire["kind"] = "future_kind"
        wire["futureField"] = ["nested": [1, 2, 3]]
        let mapped = try PrototypeEvent(wire: wire)
        XCTAssertEqual(mapped.type, .generic("future_kind"))
        XCTAssertNil(mapped.dismissReason)
        XCTAssertEqual(mapped.id, event.id)
        XCTAssertEqual(mapped.sequence, event.sequence)
        let roundtrip = try XCTUnwrap(JSONSerialization.jsonObject(with: mapped.wireJSON) as? NSDictionary)
        XCTAssertEqual(roundtrip, wire as NSDictionary)
    }

    func testCustomClientAdapterReportsTimeoutAndResponseLimitAsRequestOutcomes() async throws {
        let clients: [(PrototypeNetworkConfiguration.Client, String)] = [
            ({ _ in throw URLError(.timedOut) }, "timeout"),
            ({ request in
                let response = try XCTUnwrap(HTTPURLResponse(
                    url: XCTUnwrap(request.url), statusCode: 200, httpVersion: nil, headerFields: nil
                ))
                return (Data(repeating: 0, count: PrototypeLimits.maxResponseBytes + 1), response)
            }, "too_large"),
        ]
        let spec = try JSONDecoder().decode(PrototypeSpec.self, from: Data("""
        {"id":"client-errors","window":{"placement":{"type":"fullscreen"}},"root":{"type":"button","label":"Go",
         "onTap":[{"type":"request","url":"https://example.test/feed"}]}}
        """.utf8))
        for (client, code) in clients {
            let driver = PrototypeNetworkConfiguration(deviceClient: client).driver(clock: ManualRequestClock())
            var session = PrototypeSession()
            session.show(spec)
            var events: [PrototypeEvent] = []
            driver.onComplete = { id, response in events += session.completeRequest(id, response) }
            _ = session.run(spec.root.onTap ?? [])
            driver.perform(session.takeRequestCommands())
            await driver.settled()
            let event = try XCTUnwrap(events.first { $0.type == .request })
            let mapped = try PrototypeEvent(wire: event.wireObject(timestamp: 1))
            let payload = try JSONDecoder().decode([String: JSONValue].self, from: mapped.payloadJSON)
            XCTAssertEqual(payload["outcome"], .string("error"))
            XCTAssertEqual(payload["error"]?.objectFields?["code"], .string(code))
            XCTAssertEqual(driver.runningCount, 0)
        }
    }

    func testStorageOptionsMapWithoutWritingDefaultAppStorageAndDirectoryPersists() throws {
        XCTAssertNil(PrototypeStorageOption.none.coordinator())
        XCTAssertNotNil(PrototypeStorageOption.fileBacked.coordinator()) // Construction performs no I/O.
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let clock = ManualRequestClock()
        let coordinator = try XCTUnwrap(PrototypeStorageOption.directory(directory).coordinator(clock: clock))
        let spec = try JSONDecoder().decode(PrototypeSpec.self, from: Data("""
        {"id":"storage","window":{"placement":{"type":"fullscreen"}},"state":{"name":"initial"},
         "storage":{"version":1,"keys":["state:name"]},"root":{"type":"textField","stateKey":"name"}}
        """.utf8))
        let restored = coordinator.prepare(spec)
        var session = PrototypeSession()
        session.show(restored.spec, restoredState: restored.state)
        _ = session.change(key: "name", value: .string("saved"))
        coordinator.sessionChanged(session)
        coordinator.flush()
        let second = try XCTUnwrap(PrototypeStorageOption.directory(directory).coordinator(clock: clock))
        XCTAssertEqual(second.prepare(spec).state["name"], .string("saved"))
        XCTAssertEqual(PrototypeAssets.none.images, [:])
        XCTAssertEqual(PrototypeAssets.none.fonts, [:])
    }

    func testLoadFromDataMatchesFileDiagnosticsAndPublicValidation() throws {
        let valid = try fixture("prototype-spec/valid/text-field-actions.json")
        try PrototypeLoadError.validate(spec: valid)
        let loaded = try PrototypeEmbeddedSpec.load(data: valid)
        XCTAssertEqual(loaded.spec.id, "text-actions")
        XCTAssertEqual(loaded.bytes, try prototypeViewerCompactSpecBytes(valid))
        for invalid in [Data(), Data("not JSON".utf8), Data(#"{"id":42}"#.utf8)] {
            guard case let .invalid(path, message) = PrototypeViewerSpecLoader.load(data: invalid) else {
                return XCTFail("Expected invalid Data")
            }
            XCTAssertThrowsError(try PrototypeLoadError.validate(spec: invalid)) {
                XCTAssertEqual($0 as? PrototypeLoadError, .invalidSpec(path: path, message: message))
            }
        }
    }

    func testUnsupportedCapabilitiesRejectTheWholeSpecWithSortedMissingNames() throws {
        let valid = try fixture("prototype-spec/valid/text-field-actions.json")
        XCTAssertThrowsError(try PrototypeEmbeddedSpec.load(data: valid, supported: [])) {
            XCTAssertEqual($0 as? PrototypeLoadError, .unsupportedCapabilities([
                "prototype_text_field_actions_v1", "prototype_text_field_leading_icon_v1",
                "prototype_text_field_options_v1",
            ]))
        }
        // iOS explicitly lacks full Material variant parity; never silently draw a partial variant.
        let unsupported = Data("""
        {"id":"icons","window":{"placement":{"type":"fullscreen"}},
         "root":{"type":"icon","name":"home","variant":"twoTone"}}
        """.utf8)
        XCTAssertThrowsError(try PrototypeLoadError.validate(spec: unsupported)) {
            XCTAssertEqual($0 as? PrototypeLoadError, .unsupportedCapabilities(["prototype_icon_variant_v1"]))
        }
    }
}
