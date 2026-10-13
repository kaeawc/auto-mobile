@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeDataTests: XCTestCase {
    private var fixtureRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test/fixtures/prototype-spec")
    }

    private func fixture(_ path: String) throws -> Data {
        try Data(contentsOf: fixtureRoot.appendingPathComponent(path))
    }

    private func encoded(_ value: JSONValue) throws -> Data {
        try JSONEncoder().encode(value)
    }

    private func object(_ value: JSONValue) throws -> [String: JSONValue] {
        guard case let .object(fields) = value else {
            throw NSError(domain: "PrototypeDataTests", code: 1)
        }
        return fields
    }

    func testEverySharedPointerCase() throws {
        struct Fixture: Decodable {
            struct Entry: Decodable {
                let pointer: String
                let valid: Bool
                let found: Bool
                let value: JSONValue?
            }

            let data: [String: JSONValue]
            let cases: [Entry]
        }
        let shared = try JSONDecoder().decode(Fixture.self, from: fixture("data/pointers.json"))
        for entry in shared.cases {
            XCTAssertEqual(PrototypeDataPointer.isValid(entry.pointer), entry.valid, entry.pointer)
            let value = PrototypeDataPointer.resolve(shared.data, pointer: entry.pointer)
            XCTAssertEqual(value != nil, entry.found, entry.pointer)
            if entry.found { XCTAssertEqual(value, entry.value, entry.pointer) }
        }
    }

    func testEverySharedResolvedRootAndSpecDecode() throws {
        let directory = fixtureRoot.appendingPathComponent("data/resolve")
        let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "json" }.sorted { $0.lastPathComponent < $1.lastPathComponent }
        XCTAssertFalse(files.isEmpty)
        for file in files {
            let wrapper = try object(JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: file)))
            let rawSpec = try XCTUnwrap(wrapper["spec"])
            let spec = try object(rawSpec)
            let root = try XCTUnwrap(spec["root"])
            let data = try spec["data"].map(object)
            XCTAssertEqual(
                PrototypeDataResolver.resolveRoot(root, data: data), wrapper["root"], file.lastPathComponent
            )
            _ = try JSONDecoder().decode(PrototypeSpec.self, from: encoded(rawSpec))
        }
    }

    func testOrdersExpandLikeTheEquivalentLiteralSpec() throws {
        let bound = try JSONDecoder().decode(PrototypeSpec.self, from: fixture("valid/data-repeat-path.json"))
        let literal = try JSONDecoder().decode(PrototypeSpec.self, from: Data("""
        {"id":"orders","window":{"placement":{"type":"fullscreen"}},"state":{"liked_7":false},
         "root":{"type":"column","repeat":{"items":[{"id":7,"title":"Latte","total":4.5}],
         "as":"item","key":"id"},"children":[{"type":"text","text":"Latte 1",
         "visibleWhen":{"all":[]},"onTap":[{"type":"toggle","key":"liked_7"}]}]}}
        """.utf8))
        compare(bound.root, literal.root)
    }

    private func compare(_ actual: PrototypeNode, _ expected: PrototypeNode) {
        XCTAssertEqual(actual.type, expected.type)
        XCTAssertEqual(actual.text, expected.text)
        XCTAssertEqual(actual.visibleWhen, expected.visibleWhen)
        XCTAssertEqual(actual.children?.count, expected.children?.count)
        for (child, other) in zip(actual.children ?? [], expected.children ?? []) {
            compare(child, other)
        }
        XCTAssertEqual(actual.child != nil, expected.child != nil)
        if let child = actual.child, let other = expected.child { compare(child, other) }
    }

    func testSessionDataIsReadOnlyAcrossStateActionsAndShows() throws {
        let spec = try JSONDecoder().decode(PrototypeSpec.self, from: Data("""
        {"id":"data","window":{"placement":{"type":"fullscreen"}},
         "data":{"count":99,"orders":[{"id":7}]},"state":{"title":"old","open":false,"count":1},
         "root":{"type":"text","text":"{data:/count}"}}
        """.utf8))
        var session = PrototypeSession()
        XCTAssertNil(session.data)
        session.show(spec)
        XCTAssertEqual(session.data, spec.data)
        let actions = try JSONDecoder().decode([PrototypeAction].self, from: Data("""
        [{"type":"setState","key":"title","value":"new"},
         {"type":"toggle","key":"open"},{"type":"increment","key":"count"}]
        """.utf8))
        _ = session.run(actions)
        XCTAssertEqual(session.state, ["title": .string("new"), "open": .bool(true), "count": .number(2)])
        XCTAssertEqual(session.data, spec.data)
        let dataOnly = try JSONDecoder().decode([PrototypeAction].self, from: Data("""
        [{"type":"setState","key":"orders","value":"changed"}]
        """.utf8))
        _ = session.run(dataOnly)
        XCTAssertEqual(session.state["orders"], .string("changed"))
        XCTAssertEqual(session.data, spec.data)
        XCTAssertEqual(session.data?["orders"], .array([.object(["id": .number(7)])]))
        let plain = try JSONDecoder().decode(PrototypeSpec.self, from: Data("""
        {"id":"plain","window":{"placement":{"type":"fullscreen"}},"root":{"type":"text","text":"Hi"}}
        """.utf8))
        session.show(plain)
        XCTAssertNil(session.data)
    }

    func testSharedDataLimitsAndErrorPaths() throws {
        let exact = try JSONDecoder().decode(JSONValue.self, from: fixture("valid/data-limits-exact.json"))
        let fields = try object(exact)
        try PrototypeLimits.guardData(object(XCTUnwrap(fields["data"])))
        _ = try JSONDecoder().decode(PrototypeSpec.self, from: encoded(exact))
        for name in ["data-depth-limit", "data-array-limit", "data-null-value"] {
            let wrapper = try object(JSONDecoder().decode(JSONValue.self, from: fixture("invalid/\(name).json")))
            let spec = try object(XCTUnwrap(wrapper["spec"]))
            let data = try object(XCTUnwrap(spec["data"]))
            let path = try XCTUnwrap(wrapper["expectedPath"]?.stringValue)
            let message = try XCTUnwrap(wrapper["expectedMessage"]?.stringValue)
            assertViolation(data, "\(path): \(message)")
            XCTAssertThrowsError(try JSONDecoder().decode(PrototypeSpec.self, from: encoded(.object(spec))))
        }
    }

    private func assertViolation(_ data: [String: JSONValue], _ expected: String) {
        XCTAssertThrowsError(try PrototypeLimits.guardData(data)) { error in
            guard case let DecodingError.dataCorrupted(context) = error else {
                return XCTFail("Unexpected error: \(error)")
            }
            XCTAssertTrue(context.debugDescription.hasPrefix(expected), context.debugDescription)
        }
    }

    func testDepthBeforeArrayLengthAndSortedMemberOrder() throws {
        let oversized: JSONValue = .array(Array(repeating: .bool(true), count: 501))
        var nested = oversized
        for _ in 0 ..< 7 {
            nested = .object(["a": nested])
        }
        assertViolation(["a": nested], "data.a.a.a.a.a.a.a.a: Data depth limit exceeded")
        assertViolation(["z": .null, "a b": .null], "data[\"a b\"]: Invalid data value")
        try PrototypeLimits.guardData(["items": .array(Array(repeating: .number(0), count: 500))])
        assertViolation(["items": oversized], "data.items: Data array limit exceeded")
        var exact: JSONValue = .object(["leaf": .bool(true)])
        for _ in 0 ..< 6 {
            exact = .object(["a": exact])
        }
        try PrototypeLimits.guardData(["a": exact])
        assertViolation(["a": .object(["a": exact])], "data.a.a.a.a.a.a.a.a: Data depth limit exceeded")
    }

    func testConstantConditionsDecodeAndHold() throws {
        let yes = try JSONDecoder().decode(Condition.self, from: Data(#"{"all":[]}"#.utf8))
        let no = try JSONDecoder().decode(Condition.self, from: Data(#"{"any":[]}"#.utf8))
        XCTAssertTrue(yes.holds([:]))
        XCTAssertFalse(no.holds([:]))
        XCTAssertThrowsError(try JSONDecoder().decode(Condition.self, from: Data(#"{"data":"/n","gt":0}"#.utf8)))
    }

    func testUTF16GrammarAndReplacementValuesAreNotRescanned() {
        let key = String(repeating: "😀", count: 127)
        XCTAssertTrue(PrototypeDataPointer.isValid("/\(key)"))
        XCTAssertFalse(PrototypeDataPointer.isValid("/\(key)😀"))
        let data: [String: JSONValue] = [key: .string("astral"), "raw": .string("{data:/missing}")]
        XCTAssertEqual(PrototypeDataText.bind("😀{data:/\(key)}\u{0301}", data: data), "😀astral\u{0301}")
        XCTAssertEqual(PrototypeDataText.bind("{data:/raw}", data: data), "{data:/missing}")
        XCTAssertEqual(PrototypeDataText.bind("{data:\u{0301}/raw}", data: data), "{data:\u{0301}/raw}")
        XCTAssertEqual(PrototypeDataText.bind("{bad{data:/raw}}", data: data), "{bad{data:/missing}}")
        XCTAssertEqual(PrototypeDataPointer.tokens("/\u{0301}/"), ["\u{0301}", ""])
        XCTAssertEqual(PrototypeDataPointer.tokens("/"), [""])
        XCTAssertNil(PrototypeDataPointer.resolve(["é": .number(1)], pointer: "/e\u{0301}"))
    }

    func testPointerUnescapingUsesExactUTF16Units() {
        let cases = [("/a~1\u{0301}", "a/\u{0301}"), ("/~0\u{0301}", "~\u{0301}"), ("/~01", "~1")]
        for (pointer, expected) in cases {
            let tokens = PrototypeDataPointer.tokens(pointer)
            XCTAssertEqual(tokens.count, 1)
            XCTAssertTrue(tokens.first?.utf16.elementsEqual(expected.utf16) == true)
        }
    }

    func testPlaceholderScanBoundsPointerLengthsAndLiteralBraces() {
        let key = String(repeating: "a", count: 255)
        let data: [String: JSONValue] = [key: .string("bound"), "a": .string("one")]
        XCTAssertEqual(PrototypeDataText.bind("{data:/\(key)}", data: data), "bound")
        let overlong = "{data:/\(key)a}"
        XCTAssertEqual(PrototypeDataText.bind(overlong, data: data), overlong)
        XCTAssertEqual(PrototypeDataText.bind("{data:/a", data: data), "{data:/a")
        let braces = String(repeating: "{", count: 50000)
        XCTAssertEqual(PrototypeDataText.bind(braces + "{data:/a}", data: data), braces + "one")
    }

    func testNonStringDataPointerNotEqualsFoldsToTrue() throws {
        let root: JSONValue = .object([
            "type": .string("text"), "text": .string("x"),
            "visibleWhen": .object(["data": .number(5), "notEquals": .number(1)]),
        ])
        let resolved = try object(PrototypeDataResolver.resolveRoot(root, data: [:]))
        XCTAssertEqual(resolved["visibleWhen"], .object(["all": .array([])]))
    }

    func testDataMustDecodeAsAnObject() {
        for data in [JSONValue.null, .array([])] {
            let spec: JSONValue = .object([
                "id": .string("invalidData"),
                "window": .object(["placement": .object(["type": .string("fullscreen")])]),
                "data": data,
                "root": .object(["type": .string("text"), "text": .string("x")]),
            ])
            XCTAssertThrowsError(try JSONDecoder().decode(PrototypeSpec.self, from: encoded(spec)))
        }
    }

    func testResolverBackstopsMissingNonArrayAndNonObjectRepeatItems() throws {
        let root: JSONValue = .object([
            "type": .string("column"),
            "repeat": .object(["items": .object(["path": .string("/items")]), "as": .string("item")]),
            "children": .array([]),
        ])
        let sources: [[String: JSONValue]?] = [nil, ["items": .number(1)]]
        for data in sources {
            let fields = try object(PrototypeDataResolver.resolveRoot(root, data: data))
            let repeated = try object(XCTUnwrap(fields["repeat"]))
            XCTAssertEqual(repeated["items"], .array([]))
        }
        let item: JSONValue = .object(["id": .number(1), "nested": .array([]), "bad name": .bool(true)])
        let items = [.null] + Array(repeating: item, count: PrototypeLimits.maxRepeatItems + 1)
        let fields = try object(PrototypeDataResolver.resolveRoot(root, data: ["items": .array(items)]))
        let repeated = try object(XCTUnwrap(fields["repeat"]))
        XCTAssertEqual(repeated["items"], .array(Array(
            repeating: .object(["id": .number(1)]), count: PrototypeLimits.maxRepeatItems
        )))
    }

    func testResolvedRepeatItemsCountTowardTreeLimitsBeforeExpansion() throws {
        let child: JSONValue = .object(["type": .string("text"), "text": .string("row")])
        let spec: JSONValue = .object([
            "id": .string("bounded"),
            "window": .object(["placement": .object(["type": .string("fullscreen")])]),
            "data": .object(["items": .array(Array(repeating: .object([:]), count: 128))]),
            "root": .object([
                "type": .string("column"),
                "repeat": .object(["items": .object(["path": .string("/items")]), "as": .string("item")]),
                "children": .array(Array(repeating: child, count: 16)),
            ]),
        ])
        XCTAssertThrowsError(try JSONDecoder().decode(PrototypeSpec.self, from: encoded(spec))) { error in
            guard case let DecodingError.dataCorrupted(context) = error else {
                return XCTFail("Unexpected error: \(error)")
            }
            XCTAssertEqual(context.debugDescription, "root.repeat[124].children[15]: Node limit exceeded")
        }
    }

    func testDataConditionsUseTypedScalarEquality() {
        let data: [String: JSONValue] = ["zero": .number(-0.0), "object": .object([:]), "text": .string("é")]
        XCTAssertTrue(PrototypeDataValues.holds(["data": .string("/zero"), "equals": .number(0)], data: data))
        XCTAssertFalse(PrototypeDataValues.holds(["data": .string("/zero"), "equals": .bool(false)], data: data))
        XCTAssertTrue(PrototypeDataValues.holds(["data": .string("/object"), "notEquals": .number(0)], data: data))
        XCTAssertFalse(PrototypeDataValues.holds(
            ["data": .string("/text"), "equals": .string("e\u{0301}")], data: data
        ))
    }
}
