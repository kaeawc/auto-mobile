@testable import AutoMobilePrototypeAgentCore
import XCTest

/// `setData`, `appendData` and `removeData` (#12519): the pure write, the value bindings, the
/// session dispatch inside a repeat, the `change` event and the shared fixture.
final class PrototypeDataActionsTests: XCTestCase {
    private func object(_ json: String) throws -> [String: JSONValue] {
        guard case let .object(fields) = try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8)) else {
            throw XCTSkip("not an object")
        }
        return fields
    }

    private func spec(_ json: String) throws -> PrototypeSpec {
        try JSONDecoder().decode(PrototypeSpec.self, from: Data(json.utf8))
    }

    private func write(
        _ data: String, _ operation: PrototypeDataWrite.Operation, _ path: String, _ value: JSONValue? = nil
    )
        throws -> Result<[String: JSONValue], PrototypeDataWriteFailure>
    {
        try PrototypeDataWrite.apply(object(data), op: operation, path: path, value: value)
    }

    private func failure(_ result: Result<[String: JSONValue], PrototypeDataWriteFailure>) -> PrototypeDataWriteCode? {
        if case let .failure(failure) = result { return failure.code }
        return nil
    }

    // MARK: Pure write

    func testSetCreatesAndReplacesObjectMembersAtANestedPointer() throws {
        let created = try write(#"{"a":{"b":{}}}"#, .set, "/data/a/b/c", .string("x"))
        XCTAssertEqual(try created.get(), try object(#"{"a":{"b":{"c":"x"}}}"#))
        let replaced = try write(#"{"a":{"b":{"c":"x"}}}"#, .set, "/data/a/b/c", .number(2))
        XCTAssertEqual(try replaced.get(), try object(#"{"a":{"b":{"c":2}}}"#))
        XCTAssertEqual(try write("{}", .set, "/data/top", .bool(true)).get(), try object(#"{"top":true}"#))
    }

    func testSetReplacesAnExistingArrayElementButNeverCreatesOne() throws {
        let replaced = try write(#"{"a":[1,2]}"#, .set, "/data/a/1", .number(9))
        XCTAssertEqual(try replaced.get(), try object(#"{"a":[1,9]}"#))
        XCTAssertEqual(try failure(write(#"{"a":[1,2]}"#, .set, "/data/a/2", .number(9))), .notFound)
        XCTAssertEqual(try failure(write(#"{"a":[1]}"#, .set, "/data/a/-", .number(9))), .notFound)
    }

    func testSetNeedsAnExistingContainerParent() throws {
        XCTAssertEqual(try failure(write("{}", .set, "/data/a/b", .number(1))), .notFound)
        XCTAssertEqual(try failure(write(#"{"a":"text"}"#, .set, "/data/a/b", .number(1))), .notFound)
    }

    func testAppendPushesOntoAnExistingArray() throws {
        let appended = try write(#"{"items":[{"n":1}]}"#, .append, "/data/items", .object(["n": .number(2)]))
        XCTAssertEqual(try appended.get(), try object(#"{"items":[{"n":1},{"n":2}]}"#))
        let nested = try write(#"{"rows":[{"tags":["a"]}]}"#, .append, "/data/rows/0/tags", .string("b"))
        XCTAssertEqual(try nested.get(), try object(#"{"rows":[{"tags":["a","b"]}]}"#))
        XCTAssertEqual(try failure(write("{}", .append, "/data/items", .number(1))), .notFound)
        XCTAssertEqual(try failure(write(#"{"items":{}}"#, .append, "/data/items", .number(1))), .notArray)
        XCTAssertEqual(try failure(write(#"{"items":"x"}"#, .append, "/data/items", .number(1))), .notArray)
    }

    func testRemoveDeletesAMemberOrShiftsLaterElementsDown() throws {
        let member = try write(#"{"a":1,"b":2}"#, .remove, "/data/a")
        XCTAssertEqual(try member.get(), try object(#"{"b":2}"#))
        let element = try write(#"{"items":["x","y","z"]}"#, .remove, "/data/items/1")
        XCTAssertEqual(try element.get(), try object(#"{"items":["x","z"]}"#))
        XCTAssertEqual(try failure(write("{}", .remove, "/data/a")), .notFound)
        XCTAssertEqual(try failure(write(#"{"items":["x"]}"#, .remove, "/data/items/3")), .notFound)
    }

    func testPointerEscapesAddressMembersWithSlashesAndTildes() throws {
        let result = try write(#"{"a/b":{"c~d":1}}"#, .set, "/data/a~1b/c~0d", .number(2))
        XCTAssertEqual(try result.get(), try object(#"{"a/b":{"c~d":2}}"#))
    }

    func testPathsOutsideDataAreInvalid() throws {
        for path in ["/data", "/state/x", "data/a", "/dat/a", "", "/data/a~2", "/data/a~"] {
            XCTAssertEqual(try failure(write("{}", .set, path, .number(1))), .invalidPath, path)
        }
        let longPointer = "/data/" + String(repeating: "a", count: PrototypeLimits.maxDataPointerLength)
        XCTAssertEqual(try failure(write("{}", .remove, longPointer)), .invalidPath)
    }

    func testAValuelessSetOrAppendAndANullValueAreInvalidValues() throws {
        XCTAssertEqual(try failure(write("{}", .set, "/data/a", nil)), .invalidValue)
        XCTAssertEqual(try failure(write(#"{"a":[]}"#, .append, "/data/a", nil)), .invalidValue)
        XCTAssertEqual(try failure(write("{}", .set, "/data/a", .null)), .invalidValue)
        XCTAssertEqual(try failure(write("{}", .set, "/data/a", .number(.infinity))), .invalidValue)
    }

    func testAWriteThatBreaksADataLimitChangesNothing() throws {
        let full = "[" + (0 ..< PrototypeLimits.maxDataArrayItems).map(String.init).joined(separator: ",") + "]"
        XCTAssertEqual(try failure(write(#"{"a":\#(full)}"#, .append, "/data/a", .number(1))), .limitExceeded)
        // Depth: data is depth 1, so a ninth nested level breaks the limit.
        let deep = String(repeating: #"{"a":"#, count: PrototypeLimits.maxDataDepth - 1) + "{}" +
            String(repeating: "}", count: PrototypeLimits.maxDataDepth - 1)
        let tooDeep = try PrototypeDataWrite.apply(
            nil, op: .set, path: "/data/x", value: JSONDecoder().decode(JSONValue.self, from: Data(deep.utf8))
        )
        XCTAssertEqual(failure(tooDeep), .limitExceeded)
    }

    func testTheWriteByteLimitIsTheHostsCostRule() throws {
        // {"a":"<text>"} costs 2 braces + 3 for the quoted key + 1 colon + 2 quotes + the text.
        let fits = String(repeating: "x", count: PrototypeLimits.maxDataWriteBytes - 8)
        XCTAssertEqual(
            PrototypeLimits.dataByteCost(.object(["a": .string(fits)]), depth: 0),
            PrototypeLimits.maxDataWriteBytes
        )
        XCTAssertNotNil(try? PrototypeDataWrite.apply(nil, op: .set, path: "/data/a", value: .string(fits)).get())
        XCTAssertEqual(
            failure(PrototypeDataWrite.apply(nil, op: .set, path: "/data/a", value: .string(fits + "y"))),
            .limitExceeded
        )
        // Numbers cost 32 whatever their spelling; separators count.
        let mixed = JSONValue.array([.number(1), .bool(false), .null])
        XCTAssertEqual(PrototypeLimits.dataByteCost(mixed, depth: 0), 2 + 2 + 32 + 5 + 4)
    }

    func testTheInputIsNeverMutated() throws {
        let data = try object(#"{"items":[1,2]}"#)
        _ = PrototypeDataWrite.apply(data, op: .remove, path: "/data/items/0", value: nil)
        XCTAssertEqual(data, try object(#"{"items":[1,2]}"#))
    }

    // MARK: Value bindings

    private struct Inputs: PrototypeEmitContextInputs {
        let stateValues: [String: JSONValue]
        let dataValues: [String: JSONValue]
        func state(_ key: String) -> JSONValue? { stateValues[key] }
        func page(_: String) -> Int? { nil }
        func data(_ pointer: String) -> JSONValue? { PrototypeDataPointer.resolve(dataValues, pointer: pointer) }
    }

    func testValueBindingsResolveLiteralStateAndData() throws {
        let inputs = Inputs(stateValues: ["draft": .string("hi")], dataValues: ["title": .string("T")])
        func resolve(_ json: String) throws -> Result<JSONValue, PrototypeDataWriteFailure> {
            try PrototypeDataWrite.resolveValue(
                JSONDecoder().decode(JSONValue.self, from: Data(json.utf8)),
                inputs: inputs
            )
        }
        XCTAssertEqual(try resolve(#"{"value":{"n":1}}"#).get(), .object(["n": .number(1)]))
        XCTAssertEqual(try resolve(#"{"state":"draft"}"#).get(), .string("hi"))
        XCTAssertEqual(try resolve(#"{"data":"/title"}"#).get(), .string("T"))
        guard case let .failure(missingState) = try resolve(#"{"state":"nope"}"#) else { return XCTFail("state") }
        XCTAssertEqual(missingState.code, .invalidValue)
        guard case let .failure(missingData) = try resolve(#"{"data":"/nope"}"#) else { return XCTFail("data") }
        XCTAssertEqual(missingData.code, .notFound)
        for unbound in [#"{"item":"name"}"#, #"{"index":true}"#, #"{"page":"p"}"#, #"{"a":1,"b":2}"#, "{}", #""x""#] {
            guard case let .failure(refused) = try resolve(unbound) else { return XCTFail(unbound) }
            XCTAssertEqual(refused.code, .invalidValue, unbound)
        }
        XCTAssertEqual(failureCode(PrototypeDataWrite.resolveValue(nil, inputs: inputs)), .invalidValue)
    }

    private func failureCode(_ result: Result<JSONValue, PrototypeDataWriteFailure>) -> PrototypeDataWriteCode? {
        if case let .failure(failure) = result { return failure.code }
        return nil
    }

    // MARK: Session

    private static let listSpec = """
    {"id":"list","window":{"placement":{"type":"fullscreen"}},"state":{"draft":"New"},
     "data":{"title":"List","items":[
       {"name":"one","tags":["a"]},{"name":"two","tags":[]},{"name":"three","tags":["c"]}]},
     "root":{"type":"column","children":[
       {"type":"text","text":"{data:/title}"},
       {"type":"button","label":"Add","onTap":[
         {"type":"appendData","path":"/data/items","value":{"value":{"name":"new","tags":[]}}}]},
       {"type":"button","label":"Rename","onTap":[
         {"type":"setData","path":"/data/title","value":{"state":"draft"}}]},
       {"type":"column","repeat":{"items":{"path":"/items"},"as":"item"},"children":[
         {"type":"text","text":"{item.name}"},
         {"type":"button","label":"Tag {item.name}","onTap":[
           {"type":"appendData","path":"/data/items/{index}/tags","value":{"item":"name"}}]},
         {"type":"button","label":"Delete {item.name}","onTap":[
           {"type":"removeData","path":"/data/items/{index}"}]}]}]}}
    """

    private func nodes(_ node: PrototypeNode) -> [PrototypeNode] {
        [node] + (node.children ?? []).flatMap(nodes)
    }

    private func button(_ session: PrototypeSession, _ label: String) throws -> [PrototypeAction] {
        let root = try XCTUnwrap(session.spec?.root)
        return try XCTUnwrap(nodes(root).first { $0.type == "button" && $0.label == label }?.onTap, label)
    }

    private func texts(_ session: PrototypeSession) -> [String] {
        session.spec.map { nodes($0.root).filter { $0.type == "text" }.compactMap(\.text) } ?? []
    }

    private func shown() throws -> PrototypeSession {
        var session = PrototypeSession()
        try session.show(spec(Self.listSpec))
        return session
    }

    func testAStateWriteIsRevalidatedAgainstDataAnEarlierActionChanged() throws {
        // No row exists when the list is planned, so a string for `b` looks fine; the appended row
        // adds a switch bound to `b`, which refuses it.
        var session = PrototypeSession()
        try session.show(spec("""
        {"id":"rows","window":{"placement":{"type":"fullscreen"}},"state":{"b":true},"data":{"rows":[]},
         "root":{"type":"column","children":[
           {"type":"button","label":"Go","onTap":[
             {"type":"appendData","path":"/data/rows","value":{"value":{"n":1}}},
             {"type":"setState","key":"b","value":"not a boolean"}]},
           {"type":"column","repeat":{"items":{"path":"/rows"},"as":"row"},"children":[
             {"type":"switch","stateKey":"b"}]}]}}
        """))
        _ = try session.run(button(session, "Go"))
        XCTAssertEqual(session.data?["rows"], .array([.object(["n": .number(1)])]))
        XCTAssertEqual(session.state["b"], .bool(true))
    }

    func testAChangeEventLeavesOutAValueThatWouldNotFitAnEmitPayload() throws {
        func changePayload(_ text: String) throws -> [String: JSONValue] {
            var session = PrototypeSession()
            try session.show(spec("""
            {"id":"big","window":{"placement":{"type":"fullscreen"}},"data":{"title":"T"},
             "root":{"type":"button","label":"Go","onTap":[
               {"type":"setData","path":"/data/title","value":{"value":\(PrototypeJSONText.string(.string(text)))}}]}}
            """))
            let events = try session.run(XCTUnwrap(session.spec?.root.onTap))
            return try XCTUnwrap(events.first?.payload.objectValue)
        }
        // The whole `{op, value, revision}` payload must fit 4096 bytes of compact JSON.
        let small = try changePayload(String(repeating: "x", count: 100))
        XCTAssertNotNil(small["value"])
        let fitsExactly = try changePayload(String(repeating: "x", count: 4096 - 40))
        XCTAssertNotNil(fitsExactly["value"])
        let big = try changePayload(String(repeating: "x", count: 4096))
        XCTAssertNil(big["value"])
        XCTAssertEqual(big["op"], .string("set"))
        XCTAssertEqual(big["revision"], .number(2))
    }

    func testRepeatBindsTheRowIndexAndItemIntoEachRowsDataActions() throws {
        let session = try shown()
        let delete = try button(session, "Delete two")
        XCTAssertEqual(delete.first?.path, "/data/items/1")
        let tag = try button(session, "Tag three").first
        XCTAssertEqual(tag?.path, "/data/items/2/tags")
        XCTAssertEqual(tag?.value, .object(["value": .string("three")]))
    }

    func testRemoveInsideARepeatDropsTheRowAndReportsTheChange() throws {
        var session = try shown()
        let events = try session.run(button(session, "Delete two"))
        XCTAssertEqual(events.count, 1)
        let event = try XCTUnwrap(events.first)
        XCTAssertEqual(event.wireKind, "change")
        XCTAssertEqual(event.name, "/data/items/1")
        XCTAssertEqual(event.payload, .object(["op": .string("remove"), "revision": .number(2)]))
        XCTAssertEqual(event.sequence, 1)
        XCTAssertEqual(
            session.data?["items"],
            try object(#"{"i":[{"name":"one","tags":["a"]},{"name":"three","tags":["c"]}]}"#)["i"]
        )
        XCTAssertEqual(texts(session), ["List", "one", "three"])
        XCTAssertNil(session.spec.flatMap { nodes($0.root).first { $0.label == "Delete two" } })
        XCTAssertEqual(session.dataRevision, 2)
    }

    func testAppendInsideARepeatPushesTheRowsItemFieldAndKeepsTheRowsInPlace() throws {
        var session = try shown()
        let events = try session.run(button(session, "Tag two"))
        let event = try XCTUnwrap(events.first)
        XCTAssertEqual(event.name, "/data/items/1/tags")
        XCTAssertEqual(
            event.payload,
            .object(["op": .string("append"), "value": .string("two"), "revision": .number(2)])
        )
        guard case let .array(items)? = session.data?["items"], case let .object(second) = items[1] else {
            return XCTFail("items")
        }
        XCTAssertEqual(second["tags"], .array([.string("two")]))
        XCTAssertEqual(texts(session), ["List", "one", "two", "three"])
    }

    func testAppendAtTheListRootAddsARowAndTheNextBindingSeesIt() throws {
        var session = try shown()
        _ = try session.run(button(session, "Add"))
        XCTAssertEqual(texts(session), ["List", "one", "two", "three", "new"])
        // The new row's own buttons exist and index the appended element.
        XCTAssertEqual(try button(session, "Delete new").first?.path, "/data/items/3")
        let events = try session.run(button(session, "Delete new"))
        XCTAssertEqual(events.first?.payload.objectValue?["revision"], .number(3))
        XCTAssertEqual(texts(session), ["List", "one", "two", "three"])
    }

    func testSetFromStateRefreshesDataBoundText() throws {
        var session = try shown()
        let events = try session.run(button(session, "Rename"))
        XCTAssertEqual(events.first?.name, "/data/title")
        XCTAssertEqual(
            events.first?.payload,
            .object(["op": .string("set"), "value": .string("New"), "revision": .number(2)])
        )
        XCTAssertEqual(events.first?.state["draft"], .string("New"))
        XCTAssertEqual(texts(session).first, "New")
    }

    func testARefusedWriteChangesAndEmitsNothingButLaterActionsStillRun() throws {
        var session = try shown()
        let actions = try [
            JSONDecoder().decode(PrototypeAction.self, from: Data(
                #"{"type":"removeData","path":"/data/items/9"}"#.utf8
            )),
            JSONDecoder().decode(PrototypeAction.self, from: Data(#"{"type":"emit","name":"after"}"#.utf8)),
        ]
        let events = session.run(actions)
        XCTAssertEqual(events.map(\.name), ["after"])
        XCTAssertEqual(session.dataRevision, 1)
        XCTAssertEqual(texts(session), ["List", "one", "two", "three"])
    }

    func testTheLimitRefusalLeavesTheSessionUntouched() throws {
        let full = "[" + (0 ..< PrototypeLimits.maxDataArrayItems).map(String.init).joined(separator: ",") + "]"
        var session = PrototypeSession()
        try session.show(spec("""
        {"id":"full","window":{"placement":{"type":"fullscreen"}},"data":{"nums":\(full)},
         "root":{"type":"button","label":"More","onTap":[
           {"type":"appendData","path":"/data/nums","value":{"value":1}},
           {"type":"emit","name":"after"}]}}
        """))
        let before = session.data
        let events = try session.run(XCTUnwrap(session.spec?.root.onTap))
        XCTAssertEqual(events.map(\.name), ["after"])
        XCTAssertEqual(session.data, before)
        XCTAssertEqual(session.dataRevision, 1)
    }

    func testRevisionsAreMonotonicPerIdAcrossReshows() throws {
        var session = try shown()
        _ = try session.run(button(session, "Add"))
        _ = try session.run(button(session, "Add"))
        XCTAssertEqual(session.dataRevision, 3)
        try session.show(spec(Self.listSpec))
        XCTAssertEqual(session.dataRevision, 4)
        let events = try session.run(button(session, "Add"))
        XCTAssertEqual(events.first?.payload.objectValue?["revision"], .number(5))
        try session.show(spec(Self.listSpec.replacingOccurrences(of: #""id":"list""#, with: #""id":"other""#)))
        XCTAssertEqual(session.dataRevision, 1)
    }

    func testTheChangeEventWireObjectCarriesNameAndPayload() throws {
        var session = try shown()
        let event = try XCTUnwrap(session.run(button(session, "Rename")).first)
        let wire = event.wireObject(timestamp: 5)
        XCTAssertEqual(wire["kind"] as? String, "change")
        XCTAssertEqual(wire["name"] as? String, "/data/title")
        let payload = try XCTUnwrap(wire["payload"] as? [String: Any])
        XCTAssertEqual(payload["op"] as? String, "set")
        XCTAssertEqual(payload["revision"] as? Double, 2)
        XCTAssertNil(wire["validity"])
    }

    func testPagesSurviveAWriteThatChangesTheTree() throws {
        var session = PrototypeSession()
        try session.show(spec("""
        {"id":"pg","window":{"placement":{"type":"fullscreen"}},"data":{"items":[{"n":1},{"n":2},{"n":3}]},
         "root":{"type":"column","children":[
           {"type":"button","label":"Drop","onTap":[{"type":"removeData","path":"/data/items/0"}]},
           {"type":"pager","id":"p","repeat":{"items":{"path":"/items"},"as":"i"},
            "children":[{"type":"text","text":"{i.n}"}]}]}}
        """))
        _ = session.setPage("p", 2)
        XCTAssertEqual(session.pages["p"], 2)
        _ = try session.run(button(session, "Drop"))
        XCTAssertEqual(session.pages["p"], 1)
    }

    // MARK: Shared fixture

    func testTheSharedFixtureDecodesWithBoundRowActions() throws {
        let url = PrototypeSpecFixtures.directory.appendingPathComponent("valid/data-actions-list.json")
        let decoded = try JSONDecoder().decode(PrototypeSpec.self, from: Data(contentsOf: url))
        let paths = nodes(decoded.root).flatMap { $0.onTap ?? [] }.compactMap(\.path)
        XCTAssertEqual(paths, ["/data/items", "/data/title", "/data/items/0", "/data/items/1"])
        var session = PrototypeSession()
        session.show(decoded)
        let delete = nodes(decoded.root).first { $0.onTap?.first?.path == "/data/items/1" }?.onTap
        let events = try session.run(XCTUnwrap(delete))
        XCTAssertEqual(events.first?.name, "/data/items/1")
        XCTAssertEqual(session.data?["items"], .array([.object(["name": .string("one")])]))
    }

    // MARK: Authoring guards

    func testMenuItemsAcceptDataActionsAndRefuseABadValueBinding() throws {
        let menu = { (action: String) in
            #"""
            {"id":"m","window":{"placement":{"type":"fullscreen"}},"state":{"open":false},"data":{"items":[]},
             "root":{"type":"menu","openWhen":{"key":"open","equals":true},"items":[
               {"label":"Go","onTap":[\#(action)]}]}}
            """#
        }
        _ = try spec(menu(#"{"type":"appendData","path":"/data/items","value":{"value":1}}"#))
        _ = try spec(menu(#"{"type":"removeData","path":"/data/items/0"}"#))
        XCTAssertThrowsError(try spec(menu(#"{"type":"setData","path":"/data/items","value":{"a":1,"b":2}}"#)))
        XCTAssertThrowsError(try spec(menu(#"{"type":"removeData","path":"/data/items","value":{"value":1}}"#)))
    }
}

extension JSONValue {
    fileprivate var objectValue: [String: JSONValue]? {
        if case let .object(fields) = self { return fields }
        return nil
    }
}
