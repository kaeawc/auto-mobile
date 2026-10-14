@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeEmitContextTests: XCTestCase {
    private struct Fixture: Decodable {
        let spec: PrototypeSpec
        let state: [String: JSONValue]
        let pages: [String: Int]
        let data: [String: JSONValue]
        let precedingActions: [PrototypeAction]
        let repeatIndex: Int?
        let expected: Expected
    }

    private struct Expected: Decodable {
        let context: [String: JSONValue]
        let contextTruncated: Bool?
    }

    private struct Invalid: Decodable {
        let spec: JSONValue
        let expectedPath: String
        let expectedMessage: String
    }

    private struct FakeInputs: PrototypeEmitContextInputs {
        let values: [String: JSONValue]
        let pages: [String: Int]
        let model: [String: JSONValue]

        func state(_ key: String) -> JSONValue? { values[key] }
        func page(_ id: String) -> Int? { pages[id] }
        func data(_ pointer: String) -> JSONValue? { PrototypeDataPointer.resolve(model, pointer: pointer) }
    }

    private static var fixtureRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test/fixtures/prototype-spec")
    }

    override static func setUp() {
        super.setUp()
        // Warm lazy Foundation and spec-decoder work outside each <=15 ms test.
        let path = fixtureRoot.appendingPathComponent("emit-context/resolve/arbitrary-names.json")
        if let data = try? Data(contentsOf: path), let fixture = try? JSONDecoder().decode(Fixture.self, from: data) {
            _ = fixture.spec.root.onTap?.first?.context?.resolve(
                FakeInputs(values: fixture.state, pages: fixture.pages, model: fixture.data)
            )
        }
    }

    private func load(_ path: String) throws -> Data {
        try Data(contentsOf: Self.fixtureRoot.appendingPathComponent(path))
    }

    private func resolution(_ name: String) throws {
        let fixture = try JSONDecoder().decode(Fixture.self, from: load("emit-context/resolve/\(name).json"))
        var state = fixture.state
        for action in fixture.precedingActions {
            if let key = action.key, let value = action.value { state[key] = value }
        }
        let node: PrototypeNode
        if let index = fixture.repeatIndex {
            node = try XCTUnwrap(fixture.spec.root.children?[index])
        } else if fixture.spec.root.type == "pager" {
            node = try XCTUnwrap(fixture.spec.root.children?.first)
        } else {
            node = fixture.spec.root
        }
        let context = try XCTUnwrap(node.onTap?.first?.context)
        let result = context.resolve(FakeInputs(values: state, pages: fixture.pages, model: fixture.data))
        XCTAssertEqual(result.context, fixture.expected.context)
        XCTAssertEqual(result.contextTruncated, fixture.expected.contextTruncated)
    }

    private func valid(_ name: String) throws {
        _ = try JSONDecoder().decode(PrototypeSpec.self, from: load("valid/emit-context-\(name).json"))
    }

    private func invalid(_ name: String) throws {
        let fixture = try JSONDecoder().decode(Invalid.self, from: load("invalid/emit-context-\(name).json"))
        let data = try JSONEncoder().encode(fixture.spec)
        XCTAssertThrowsError(try JSONDecoder().decode(PrototypeSpec.self, from: data)) { error in
            guard case let DecodingError.dataCorrupted(context) = error else {
                return XCTFail("Expected context validation error, got \(error)")
            }
            XCTAssertEqual(context.debugDescription, "\(fixture.expectedPath): \(fixture.expectedMessage)")
        }
    }

    func testResolveArbitraryNames() throws { try resolution("arbitrary-names") }

    func testResolveDataObjectArray() throws { try resolution("data-object-array") }

    func testResolveDataRepeatRow3() throws { try resolution("data-repeat-row-3") }

    func testResolveEmpty() throws { try resolution("empty") }

    func testResolveExactBudget() throws { try resolution("exact-budget") }

    func testResolveFirstTooLarge() throws { try resolution("first-too-large") }

    func testResolveLiteralJson() throws { try resolution("literal-json") }

    func testResolveLiteralPayload() throws { try resolution("literal-payload") }

    func testResolveMissingNull() throws { try resolution("missing-null") }

    func testResolveNameOrderTruncation() throws { try resolution("name-order-truncation") }

    func testResolvePage() throws { try resolution("page") }

    func testResolvePrefixTruncation() throws { try resolution("prefix-truncation") }

    func testResolveRepeatRow3() throws { try resolution("repeat-row-3") }

    func testResolveStateAfterSet() throws { try resolution("state-after-set") }

    func testResolveUtf8ByteBudget() throws { try resolution("utf8-byte-budget") }

    func testResolveUtf8NameOrderTruncation() throws { try resolution("utf8-name-order-truncation") }

    func testValid16Entries() throws { try valid("16-entries") }

    func testValidArbitraryNames() throws { try valid("arbitrary-names") }

    func testValidDataRepeat() throws { try valid("data-repeat") }

    func testValidData() throws { try valid("data") }

    func testValidEmpty() throws { try valid("empty") }

    func testValidPage() throws { try valid("page") }

    func testValidPayload() throws { try valid("payload") }

    func testValidRepeat() throws { try valid("repeat") }

    func testValidState() throws { try valid("state") }

    func testValidValue() throws { try valid("value") }

    func testInvalid17Entries() throws { try invalid("17-entries") }

    func testInvalidEmptyName() throws { try invalid("empty-name") }

    func testInvalidIndexFalse() throws { try invalid("index-false") }

    func testInvalidIndexOutside() throws { try invalid("index-outside") }

    func testInvalidInvalidPointer() throws { try invalid("invalid-pointer") }

    func testInvalidItemMissingInOneRow() throws { try invalid("item-missing-in-one-row") }

    func testInvalidItemOutside() throws { try invalid("item-outside") }

    func testInvalidTwoKeys() throws { try invalid("two-keys") }

    func testInvalidUnknownItem() throws { try invalid("unknown-item") }

    func testInvalidUnknownKind() throws { try invalid("unknown-kind") }

    func testInvalidUnprojectedDataItem() throws { try invalid("unprojected-data-item") }

    func testFixtureInventoryIncludesEveryCase() throws {
        let resolve = try FileManager.default.contentsOfDirectory(
            at: Self.fixtureRoot.appendingPathComponent("emit-context/resolve"), includingPropertiesForKeys: nil
        ).filter { $0.pathExtension == "json" }.map { $0.deletingPathExtension().lastPathComponent }.sorted()
        XCTAssertEqual(resolve, [
            "arbitrary-names", "data-object-array", "data-repeat-row-3", "empty", "exact-budget",
            "first-too-large", "literal-json", "literal-payload", "missing-null", "name-order-truncation",
            "page", "prefix-truncation", "repeat-row-3", "state-after-set", "utf8-byte-budget",
            "utf8-name-order-truncation",
        ])
    }

    /// Existing Swift setPage decoding has no pager-existence cross-check; the host rejects this.
    func testUnknownPagerFixtureIsExplicitlyHostValidated() throws {
        let fixture = try JSONDecoder().decode(Invalid.self, from: load("invalid/emit-context-unknown-page.json"))
        XCTAssertNoThrow(try JSONDecoder().decode(PrototypeSpec.self, from: JSONEncoder().encode(fixture.spec)))
        XCTAssertEqual(fixture.expectedMessage, "Unknown pager id")
    }

    func testTapThirdRepeatRowKeepsTypesAndReadsThePrecedingStateWrite() throws {
        let spec = try JSONDecoder().decode(PrototypeSpec.self, from: Data(#"""
        {"id":"p","window":{"placement":{"type":"fullscreen"}},"state":{"liked_3":false},
         "root":{"type":"column","repeat":{"as":"item","items":[{"id":1},{"id":2},{"id":3}]},
          "children":[{"type":"text","text":"Row {item.id}","onTap":[
           {"type":"setState","key":"liked_{item.id}","value":true},
           {"type":"emit","name":"pick","payload":{"id":"{item.id}"},"context":{
            "orderId":{"item":"id"},"row":{"index":true},"liked":{"state":"liked_{item.id}"}}}]}]}}
        """#.utf8))
        var session = PrototypeSession()
        session.show(spec)
        let thirdRow = try XCTUnwrap(spec.root.children?[2])
        let events = try XCTUnwrap(session.activate(.node(thirdRow)))
        let emitted = try XCTUnwrap(events.first)
        XCTAssertEqual(emitted.context, ["orderId": .number(3), "row": .number(2), "liked": .bool(true)])
        XCTAssertEqual(emitted.payload, .object(["id": .string("{item.id}")]))
        XCTAssertNil(emitted.contextTruncated)
        XCTAssertNotNil(emitted.wireObject(timestamp: 0)["context"])
        XCTAssertNil(emitted.wireObject(timestamp: 0)["contextTruncated"])
        XCTAssertNil(events.last?.context, "automatic change emits carry no declared context")
    }

    func testSessionOverBudgetEmitsPrefixAndTrueFlag() throws {
        let fixture = try JSONDecoder().decode(
            Fixture.self,
            from: load("emit-context/resolve/name-order-truncation.json")
        )
        var session = PrototypeSession()
        session.show(fixture.spec)
        let events = try XCTUnwrap(session.activate(.node(fixture.spec.root)))
        let event = try XCTUnwrap(events.first)
        XCTAssertEqual(event.context, ["a": .number(1)])
        XCTAssertEqual(event.contextTruncated, true)
        let wire = event.wireObject(timestamp: 0)
        XCTAssertEqual(wire["contextTruncated"] as? Bool, true)
        let decoded = try JSONDecoder().decode(JSONValue.self, from: JSONSerialization.data(withJSONObject: wire))
        guard case let .object(fields) = decoded else { return XCTFail("Expected wire object") }
        XCTAssertEqual(fields["context"], .object(["a": .number(1)]))
    }

    func testEventJSONOmitsContextAndFlagWhenUnset() throws {
        let event = PrototypeEvent(
            id: "p", sequence: 1, kind: "emit", name: "pick", payload: .null, state: [:], pages: [:]
        )
        let wire = try JSONDecoder().decode(
            JSONValue.self, from: JSONSerialization.data(withJSONObject: event.wireObject(timestamp: 0))
        )
        guard case let .object(fields) = wire else { return XCTFail("Expected object") }
        XCTAssertNil(fields["context"])
        XCTAssertNil(fields["contextTruncated"])
    }

    func testRejectedLaterWriteDropsContextEmitAtomically() throws {
        let spec = try JSONDecoder().decode(PrototypeSpec.self, from: Data(#"""
        {"id":"p","window":{"placement":{"type":"fullscreen"}},"state":{"query":""},
         "root":{"type":"column","children":[{"type":"textField","stateKey":"query"},
          {"type":"text","text":"Tap","onTap":[
           {"type":"emit","name":"pick","context":{"query":{"state":"query"}}},
           {"type":"setState","key":"query","value":3}]}]}}
        """#.utf8))
        var session = PrototypeSession()
        session.show(spec)
        XCTAssertTrue(try session.run(XCTUnwrap(spec.root.children?[1].onTap)).isEmpty)
        XCTAssertEqual(session.state["query"], .string(""))
        XCTAssertEqual(session.lastSequence, 0)
    }

    func testEmptyTemplateStillRejectsMalformedContext() throws {
        let spec = #"""
        {"id":"p","window":{"placement":{"type":"fullscreen"}},
         "root":{"type":"column","repeat":{"as":"item","items":[]},
          "children":[{"type":"text","text":"Tap","onTap":[
           {"type":"emit","name":"pick","context":{"row":{"index":false}}}]}]}}
        """#
        XCTAssertThrowsError(try JSONDecoder().decode(PrototypeSpec.self, from: Data(spec.utf8)))
    }

    func testLiteralDepthAndFiniteJSONBackstop() {
        var value = JSONValue.number(1)
        for _ in 0 ..< 25 {
            value = .array([value])
        }
        for literal in [value, .number(.infinity), .number(.nan)] {
            XCTAssertThrowsError(try PrototypeEmitContext.validate(
                .object(["literal": .object(["value": literal])]), path: "context"
            ))
        }
        XCTAssertNoThrow(try PrototypeEmitContext.validate(
            .object(["literal": .object(["value": .null])]),
            path: "context"
        ))
    }

    func testStrictIndexJSONTypesAndContextShape() throws {
        for value in ["false", "1", #""true""#] {
            XCTAssertThrowsError(try JSONDecoder().decode(
                PrototypeEmitContext.self,
                from: Data("{\"row\":{\"index\":\(value)}}".utf8)
            ))
        }
        for json in ["[]", "null", #"{"x":{}}"#, #"{"x":{"value":1,"extra":2}}"#] {
            XCTAssertThrowsError(try JSONDecoder().decode(PrototypeEmitContext.self, from: Data(json.utf8)))
        }
    }

    func testUtf8NameComparisonDiffersFromUtf16() throws {
        let bmp = "\u{E000}"
        let supplementary = "\u{10000}"
        let value = JSONValue.string(String(repeating: "x", count: 4085))
        let raw = JSONValue.object([
            supplementary: .object(["value": .number(1)]), bmp: .object(["value": value]),
        ])
        let context = try JSONDecoder().decode(PrototypeEmitContext.self, from: JSONEncoder().encode(raw))
        XCTAssertEqual(
            context.resolve(FakeInputs(values: [:], pages: [:], model: [:])),
            PrototypeResolvedEmitContext(context: [bmp: value], contextTruncated: true)
        )
    }

    func testPageAndDataLookupsAtTheEmitExecutionPoint() throws {
        let spec = try JSONDecoder().decode(PrototypeSpec.self, from: Data(#"""
        {"id":"p","window":{"placement":{"type":"fullscreen"}},"data":{"record":{"id":3}},
         "root":{"type":"pager","id":"pages","children":[
          {"type":"text","text":"Tap","onTap":[
           {"type":"setPage","pager":"pages","page":1},
           {"type":"emit","name":"pick","context":{
            "page":{"page":"pages"},"record":{"data":"/record"},"missing":{"data":"/absent"}}}]},
          {"type":"text","text":"Other"}]}}
        """#.utf8))
        var session = PrototypeSession()
        session.show(spec)
        let events = try XCTUnwrap(session.activate(.node(XCTUnwrap(spec.root.children?.first))))
        XCTAssertEqual(events.last?.context, [
            "page": .number(1), "record": .object(["id": .number(3)]), "missing": .null,
        ])
    }

    func testRepeatCompositePartBindsTypedContextAndLeavesPayloadLiteral() throws {
        let spec = try JSONDecoder().decode(PrototypeSpec.self, from: Data(#"""
        {"id":"p","window":{"placement":{"type":"fullscreen"}},
         "root":{"type":"column","repeat":{"as":"item","items":[{"id":3}]},
          "children":[{"type":"topAppBar","title":"Pick","navigationIcon":{
           "icon":"back","label":"Pick","onTap":[{"type":"emit","name":"pick",
            "payload":{"id":"{item.id}"},"context":{"id":{"item":"id"}}}]}}]}}
        """#.utf8))
        let button = try XCTUnwrap(spec.root.children?.first?.navigationIcon)
        var session = PrototypeSession()
        session.show(spec)
        let events = try XCTUnwrap(session.activate(.appBarButton(button)))
        XCTAssertEqual(events.first?.context, ["id": .number(3)])
        XCTAssertEqual(events.first?.payload, .object(["id": .string("{item.id}")]))
    }

    func testEveryBindingIsResolvedEvenWhenTheFirstSortedEntryIsTooLarge() throws {
        final class CountingInputs: PrototypeEmitContextInputs {
            var keys: Set<String> = []
            func state(_ key: String) -> JSONValue? {
                keys.insert(key)
                return .string(String(repeating: "x", count: 4096))
            }

            func page(_: String) -> Int? { nil }
            func data(_: String) -> JSONValue? { nil }
        }
        let context = try JSONDecoder().decode(PrototypeEmitContext.self, from: Data(
            #"{"a":{"state":"first"},"z":{"state":"last"}}"#.utf8
        ))
        let inputs = CountingInputs()
        let result = context.resolve(inputs)
        XCTAssertEqual(inputs.keys, ["first", "last"])
        XCTAssertEqual(result.context, [:])
        XCTAssertEqual(result.contextTruncated, true)
    }
}
