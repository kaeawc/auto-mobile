@testable import AutoMobilePrototypeAgentCore
import XCTest

/// `{object}` data-action values (#18826).
final class PrototypeObjectDataValueTests: XCTestCase {
    private func fixture(_ name: String) throws -> Data {
        try Data(contentsOf: PrototypeSpecFixtures.directory.appendingPathComponent("valid/\(name)"))
    }

    private struct Inputs: PrototypeEmitContextInputs {
        func state(_ key: String) -> JSONValue? { key == "draft" ? .string("Buy milk") : nil }
        func page(_: String) -> Int? { nil }
        func data(_ pointer: String) -> JSONValue? { pointer == "/todos/0/title" ? .string("Walk dog") : nil }
    }

    private func json(_ text: String) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
    }

    func testObjectWritesRequireV3InStrictAndBundleChecks() throws {
        for name in ["data-object-append.json", "data-object-repeat.json"] {
            let bytes = try fixture(name)
            let required = try Set(PrototypeBundleCapabilities.required(bytes))
            XCTAssertTrue(required.contains("prototype_data_actions_v3"), name)
            XCTAssertNoThrow(try PrototypeSpecStrictValidator.validate(data: bytes, supportedCapabilities: required))
            XCTAssertThrowsError(try PrototypeSpecStrictValidator.validate(
                data: bytes, supportedCapabilities: required.subtracting(["prototype_data_actions_v3"])
            ))
        }
        let flat = try Set(PrototypeBundleCapabilities.required(fixture("data-actions-list.json")))
        XCTAssertFalse(flat.contains("prototype_data_actions_v3"))
        XCTAssertTrue(PrototypeAgentProtocol.capabilities.contains("prototype_data_actions_v3"))
    }

    func testEveryDataWriteRefusesASecureStateMemberOrValue() throws {
        let secure = ["state:token"]
        for type in ["setData", "appendData", "prependData", "upsertData"] {
            XCTAssertThrowsError(try PrototypeSecureStorageRules.validateDataAction([
                "type": .string(type), "path": .string("/data/rows"),
                "value": json(#"{"object":{"title":{"state":"draft"},"secret":{"state":"token"}}}"#),
            ], path: "action", secure: secure), type) {
                XCTAssertTrue(String(describing: $0).contains("action.value.object.secret"), type)
            }
            XCTAssertThrowsError(try PrototypeSecureStorageRules.validateDataAction([
                "type": .string(type), "path": .string("/data/rows"),
                "value": .object(["state": .string("token")]),
            ], path: "action", secure: secure), type)
            XCTAssertNoThrow(try PrototypeSecureStorageRules.validateDataAction([
                "type": .string(type), "path": .string("/data/rows"),
                "value": json(#"{"object":{"title":{"state":"draft"}}}"#),
            ], path: "action", secure: secure), type)
        }
    }

    func testMembersResolveLikeTopLevelValuesAndAMissingSourceFails() throws {
        let resolved = try PrototypeDataWrite.resolveValue(json("""
        {"object":{"title":{"state":"draft"},"from":{"data":"/todos/0/title"},"done":{"value":false}}}
        """), inputs: Inputs()).get()
        XCTAssertEqual(resolved, .object([
            "title": .string("Buy milk"), "from": .string("Walk dog"), "done": .bool(false),
        ]))
        guard case let .failure(missingState) = try PrototypeDataWrite.resolveValue(
            json(#"{"object":{"t":{"state":"nope"}}}"#), inputs: Inputs()
        ) else { return XCTFail("state") }
        XCTAssertEqual(missingState.code, .invalidValue)
        guard case let .failure(missingData) = try PrototypeDataWrite.resolveValue(
            json(#"{"object":{"t":{"data":"/nope"}}}"#), inputs: Inputs()
        ) else { return XCTFail("data") }
        XCTAssertEqual(missingData.code, .notFound)
        guard case .failure = try PrototypeDataWrite.resolveValue(
            json(#"{"object":{"t":{"object":{"u":{"value":1}}}}}"#), inputs: Inputs()
        ) else { return XCTFail("nested") }
    }

    func testRepeatItemAndIndexMembersBindPerRow() throws {
        let raw = try json("""
        {"type":"appendData","path":"/data/archive","value":{"object":{"title":{"item":"title"},"at":{"index":true},"done":{"value":true}}}}
        """)
        let instance = PrototypeRepeatInstance(alias: "todo", item: ["title": .string("Walk dog")], index: 2)
        XCTAssertEqual(instance.bindAction(raw).objectFields?["value"], .object(["object": .object([
            "title": .object(["value": .string("Walk dog")]),
            "at": .object(["value": .number(2)]),
            "done": .object(["value": .bool(true)]),
        ])]))
    }

    func testAppendWritesTheResolvedObject() throws {
        let spec = try JSONDecoder().decode(PrototypeSpec.self, from: fixture("data-object-append.json"))
        var session = PrototypeSession()
        session.show(spec)
        let actions = try XCTUnwrap(spec.root.children?.last?.onTap)
        _ = try session.run([XCTUnwrap(actions.first)])
        XCTAssertEqual(session.data?["todos"], .array([
            .object(["title": .string("Walk dog"), "done": .bool(true)]),
            .object(["title": .string("Buy milk"), "done": .bool(false)]),
        ]))
    }

    func testUpsertKeyMustStartWithAMember() throws {
        func upsert(_ key: String, _ members: String) throws {
            try PrototypeSpecStrictValidator.validate(data: Data("""
            {"id":"todo","window":{"placement":{"type":"fullscreen"}},"state":{"draft":"x"},"data":{"todos":[]},
            "root":{"type":"button","label":"Add","onTap":[{"type":"upsertData","path":"/data/todos","key":"\(key)",
            "value":{"object":\(members)}}]}}
            """.utf8))
        }
        XCTAssertNoThrow(try upsert("/title", #"{"title":{"state":"draft"}}"#))
        XCTAssertNoThrow(try upsert("/meta/id", #"{"meta":{"value":{"id":1}}}"#))
        XCTAssertNoThrow(try upsert("/id", #"{"id":{"value":7}}"#))
        for (key, members) in [
            ("/id", #"{"title":{"state":"draft"}}"#),
            ("/id", #"{"id":{"value":null}}"#),
            ("/meta/id", #"{"meta":{"value":{"other":1}}}"#),
        ] {
            XCTAssertThrowsError(try upsert(key, members)) { error in
                guard case let .invalidSpec(path, _)? = error as? PrototypeLoadError else { return XCTFail("\(error)") }
                XCTAssertEqual(path, "root.onTap[0].key")
            }
        }
    }
}
