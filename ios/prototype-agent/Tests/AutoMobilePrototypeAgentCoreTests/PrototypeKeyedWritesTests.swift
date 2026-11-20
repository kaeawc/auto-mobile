@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeKeyedWritesTests: XCTestCase {
    private func fixture() throws -> Data {
        try Data(contentsOf: PrototypeSpecFixtures.directory.appendingPathComponent("valid/keyed-data-writes.json"))
    }

    func testCapabilitiesModelsAndRefusal() throws {
        let bytes = try fixture()
        let required = try Set(PrototypeBundleCapabilities.required(bytes))
        XCTAssertTrue(required.contains("prototype_data_actions_v2"))
        XCTAssertNoThrow(try PrototypeSpecStrictValidator.validate(data: bytes, supportedCapabilities: required))
        XCTAssertThrowsError(try PrototypeSpecStrictValidator.validate(
            data: bytes, supportedCapabilities: required.subtracting(["prototype_data_actions_v2"])
        ))
        XCTAssertTrue(PrototypeAgentProtocol.capabilities.contains("prototype_data_actions_v2"))
    }

    func testRuntimeResolvesSelectorsAndReportsReplayableEvents() throws {
        let spec = try JSONDecoder().decode(PrototypeSpec.self, from: fixture())
        var session = PrototypeSession()
        session.show(spec)
        let before = session.dataRevision
        let events = try session.run(XCTUnwrap(spec.root.onTap))
        XCTAssertEqual(session.data?["items"], .array([.object(["id": .number(2), "title": .string("new")])]))
        XCTAssertEqual(events.count, 2)
        XCTAssertGreaterThan(session.dataRevision, before)
        let first = try XCTUnwrap(events.first)
        let write = try XCTUnwrap(PrototypeDataWriteEvent.decode(
            kind: first.wireKind,
            name: first.name,
            payload: first.payload
        ))
        XCTAssertEqual(write.where, .init(field: "id", equals: .number(2)))
        XCTAssertEqual(write.member, "title")
        XCTAssertEqual(write.payload, first.payload)
        XCTAssertEqual(PrototypeStrictBindings.array(spec.data?["items"]).count, 2)
    }

    func testSelectorItemAndIndexBindWithoutChangingNames() throws {
        for (source, expected) in [(#"{"item":"id"}"#, 9), (#"{"index":true}"#, 3)] {
            let raw = try JSONDecoder().decode(JSONValue.self, from: Data("""
            {"type":"removeData","path":"/data/items","where":{"field":"id","equals":\(source)}}
            """.utf8))
            let instance = PrototypeRepeatInstance(alias: "row", item: ["id": .number(9)], index: 3)
            let bound = instance.bindAction(raw)
            XCTAssertEqual(
                bound.objectFields?["where"],
                .object(["field": .string("id"), "equals": .object(["value": .number(Double(expected))])])
            )
        }
    }

    func testDuplicateMatchesLeaveRevisionAndEventsUnchanged() throws {
        let json = try String(decoding: fixture(), as: UTF8.self).replacingOccurrences(
            of: #""id": 1"#,
            with: #""id": 2"#
        )
        let spec = try JSONDecoder().decode(PrototypeSpec.self, from: Data(json.utf8))
        var session = PrototypeSession()
        session.show(spec)
        let revision = session.dataRevision
        let events = try session.run(XCTUnwrap(spec.root.onTap))
        XCTAssertTrue(events.isEmpty)
        XCTAssertEqual(session.dataRevision, revision)
        XCTAssertEqual(session.data, spec.data)
    }

    func testUnreportableSelectorIsRefusedBeforeMutation() throws {
        let id = String(repeating: "x", count: PrototypeLimits.maxEmitPayloadBytes)
        let json = """
        {"id":"big-key","window":{"placement":{"type":"fullscreen"}},"data":{"items":[{"id":"\(id)","title":"old"}]},
        "root":{"type":"button","label":"Edit","onTap":[{"type":"setData","path":"/data/items",
        "where":{"field":"id","equals":{"data":"/items/0/id"}},"member":"title","value":{"value":"new"}}]}}
        """
        let spec = try JSONDecoder().decode(PrototypeSpec.self, from: Data(json.utf8))
        var session = PrototypeSession()
        session.show(spec)
        let revision = session.dataRevision
        XCTAssertTrue(try session.run(XCTUnwrap(spec.root.onTap)).isEmpty)
        XCTAssertEqual(session.data, spec.data)
        XCTAssertEqual(session.dataRevision, revision)
    }

    func testStrictKeyedFields() throws {
        let json = try String(decoding: fixture(), as: UTF8.self)
        let invalid = [
            json.replacingOccurrences(of: #""member": "title""#, with: #""member": "a/b""#),
            json.replacingOccurrences(of: #""field": "id""#, with: #""field": """#),
            json.replacingOccurrences(of: #""type": "removeData""#, with: #""member": "title", "type": "removeData""#),
            json.replacingOccurrences(of: #""type": "setData""#, with: #""type": "appendData""#),
            json.replacingOccurrences(of: #""field": "id""#, with: #""extra": true, "field": "id""#),
        ]
        for candidate in invalid {
            XCTAssertThrowsError(try PrototypeSpecStrictValidator.validate(data: Data(candidate.utf8)))
        }
    }
}
