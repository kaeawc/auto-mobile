@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeNestedRepeatTests: XCTestCase {
    override class func setUp() {
        super.setUp()
        let data =
            Data(#"{"id":"warm","window":{"placement":{"type":"fullscreen"}},"root":{"type":"text","text":"ok"}}"#.utf8)
        do { try PrototypeSpecStrictValidator.validate(data: data) }
        catch { XCTFail("Could not initialize contract: \(error)") }
    }

    struct Fixture: Decodable {
        let name: String
        let spec: JSONValue
        let data: JSONValue?
        let state: JSONValue?
        let expected: Expected
        struct Expected: Decodable { let rows: [Row] }
        struct Row: Decodable, Equatable {
            let outerIndex: Int
            let innerIndex: Int
            let texts: [String]
        }

        func envelope() throws -> Data {
            var fields = spec.objectFields ?? [:]
            if let data { fields["data"] = data }
            if let state { fields["state"] = state }
            return try JSONEncoder().encode(JSONValue.object(fields))
        }
    }

    static func fixtures() throws -> [Fixture] {
        try JSONDecoder().decode([Fixture].self, from: Data(
            contentsOf:
            PrototypeSpecFixtures.directory.appendingPathComponent("repeat/nested.json")
        ))
    }

    func testAllSharedValidFixtures() throws {
        let fixtures = try Self.fixtures()
        XCTAssertEqual(fixtures.count, 6)
        for fixture in fixtures {
            XCTAssertNoThrow(try PrototypeSpecStrictValidator.validate(data: fixture.envelope()), fixture.name)
        }
    }

    func testEverySharedInvalidFixtureHasIdenticalPathAndMessage() throws {
        struct Invalid: Decodable {
            let spec: JSONValue
            let expectedPath: String
            let expectedMessage: String
        }
        let directory = PrototypeSpecFixtures.directory.appendingPathComponent("invalid")
        let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            .filter { $0.lastPathComponent.hasPrefix("nested-repeat-") }.sorted { $0.path < $1.path }
        XCTAssertEqual(files.count, 11)
        for file in files {
            let fixture = try JSONDecoder().decode(Invalid.self, from: Data(contentsOf: file))
            XCTAssertThrowsError(
                try PrototypeSpecStrictValidator
                    .validate(data: JSONEncoder().encode(fixture.spec))
            ) { error in
                XCTAssertEqual(
                    error as? PrototypeLoadError,
                    .invalidSpec(path: fixture.expectedPath, message: fixture.expectedMessage),
                    file.lastPathComponent
                )
            }
        }
    }

    func testStrictCapabilityPolicyUsesSharedFixture() throws {
        let fixture = try JSONDecoder().decode(JSONValue.self, from: Data(
            contentsOf:
            PrototypeSpecFixtures.directory
                .appendingPathComponent("invalid/strict-gate-prototype_nested_repeat_v1.json")
        ))
        let fields = try XCTUnwrap(fixture.objectFields)
        let spec = try XCTUnwrap(fields["spec"])
        let data = try JSONEncoder().encode(spec)
        let required = PrototypeStrictCapabilities.required(spec.objectFields ?? [:])
        XCTAssertTrue(required.contains(PrototypeAgentProtocol.nestedRepeatCapability))
        let supported = Set(
            PrototypeContractValidator
                .strings(fields["options"]?.objectFields?["supportedCapabilities"])
        )
        XCTAssertEqual(required.subtracting(supported), [PrototypeAgentProtocol.nestedRepeatCapability])
        XCTAssertThrowsError(try PrototypeSpecStrictValidator.validate(
            data: data,
            supportedCapabilities: supported
        )) { error in
            XCTAssertEqual(error as? PrototypeLoadError, .invalidSpec(
                path: "$", message: "Unsupported capabilities: prototype_nested_repeat_v1"
            ))
        }
        XCTAssertNoThrow(try PrototypeSpecStrictValidator.validate(data: data, supportedCapabilities: required))
    }

    func testCapabilityAdvertisementAndBundleRequirements() throws {
        struct MinimumOS: OSVersionProvider { let majorVersion = 17 }
        let capability = PrototypeAgentProtocol.nestedRepeatCapability
        XCTAssertTrue(PrototypeAgentProtocol.advertisedCapabilities(os: MinimumOS()).contains(capability))
        XCTAssertTrue(AutoMobilePrototypeCapabilities.supported.contains(capability))
        for fixture in try Self.fixtures() {
            XCTAssertTrue(
                try PrototypeBundleCapabilities.required(fixture.envelope()).contains(capability),
                fixture.name
            )
        }
        XCTAssertFalse(PrototypeStrictCapabilities.required([
            "root": .object(["type": .string("text"), "text": .string("{outerIndex}")]),
        ]).contains(capability))
    }

    func testInnerLimitAndProductBudgets() throws {
        XCTAssertNoThrow(try PrototypeSpecStrictValidator.validate(data: nestedSpec(outer: 2, inner: 100)))
        try rejects(nestedSpec(outer: 1, inner: 101), "Repeat field resolves to more than 100 items")
        try rejects(nestedSpec(outer: 20, inner: 100), "Expanded node limit exceeded")
        XCTAssertNoThrow(try PrototypeSpecStrictValidator.validate(
            data:
            nestedSpec(outer: 2, inner: 16, node: .object(["type": .string("image"), "asset": .string("photo")]))
        ))
        try rejects(nestedSpec(outer: 3, inner: 11, node: .object([
            "type": .string("image"), "asset": .string("photo"),
        ])), "Expanded image limit exceeded")
    }

    func testMotionBudgetChargesEveryPair() throws {
        let node = try JSONDecoder().decode(JSONValue.self, from: Data(#"""
        {"type":"icon","name":"favorite","keyframes":{"trigger":{"key":"liked"},
         "durationMs":600,"tracks":{"scale":[[0,1],[0.5,1.3],[1,1]]}}}
        """#.utf8))
        var fields = try XCTUnwrap(
            JSONDecoder()
                .decode(JSONValue.self, from: nestedSpec(outer: 3, inner: 6, node: node)).objectFields
        )
        fields["state"] = .object(["liked": .bool(false)])
        try rejects(JSONEncoder().encode(JSONValue.object(fields)), "Keyframe node limit exceeded")
    }

    func testCellAndTextBudgetsChargeEveryInnerArray() throws {
        var fields = try XCTUnwrap(
            JSONDecoder().decode(JSONValue.self, from: nestedSpec(outer: 128, inner: 100))
                .objectFields
        )
        var data = try XCTUnwrap(fields["data"]?.objectFields)
        data["orders"] = .array((0 ..< 128).map { index in .object([
            "id": .number(Double(index)), "lines": .array(Array(repeating: .object([
                "sku": .string("x"), "a": .number(1), "b": .number(2),
                "c": .number(3), "d": .number(4), "e": .number(5),
            ]), count: 100)),
        ]) })
        fields["data"] = .object(data)
        var roots = fields["root"]?.objectFields ?? [:]
        guard case var .array(children)? = roots["children"], var inner = children[0].objectFields else {
            return XCTFail("Missing inner repeat")
        }
        inner["children"] = .array([])
        children[0] = .object(inner)
        roots["children"] = .array(children)
        fields["root"] = .object(roots)
        let root = try XCTUnwrap(fields["root"])
        XCTAssertThrowsError(try PrototypeLimits.guardRepeatPathCells(root, data: data)) { error in
            XCTAssertTrue("\(error)".contains("Repeat path cell limit exceeded"))
        }
        let fixture = try XCTUnwrap(Self.fixtures().first)
        var original = try XCTUnwrap(JSONDecoder().decode(JSONValue.self, from: fixture.envelope()).objectFields)
        var originalData = try XCTUnwrap(original["data"]?.objectFields)
        originalData["orders"] = .array([.object([
            "id": .string("A"),
            "customer": .string(String(repeating: "x", count: PrototypeLimits.maxSubstitutedTextLength + 1)),
            "lines": .array([.object(["sku": .string("PEN"), "qty": .number(1)])]),
        ])])
        original["data"] = .object(originalData)
        try rejects(JSONEncoder().encode(JSONValue.object(original)), "Substituted text length limit exceeded")
    }

    func testThirdLevelRejectedWithEmptyOuter() throws {
        try rejects(nestedSpec(outer: 0, inner: 0, node: .object([
            "type": .string("column"), "repeat": .object([
                "as": .string("third"), "items": .object(["field": .string("lines")]),
            ]), "children": .array([]),
        ])), "Repeat nesting depth exceeds 2")
    }

    private func rejects(_ data: Data, _ message: String) throws {
        XCTAssertThrowsError(try PrototypeSpecStrictValidator.validate(data: data)) { error in
            guard case let PrototypeLoadError.invalidSpec(_, actual) = error else { return XCTFail("\(error)") }
            XCTAssertEqual(actual, message)
        }
    }

    private func nestedSpec(outer: Int, inner: Int, node: JSONValue = .object([
        "type": .string("text"), "text": .string("{order.id}/{outerIndex}/{line.sku}/{index}"),
    ])) throws -> Data {
        let rows = (0 ..< outer).map { index in JSONValue.object([
            "id": .number(Double(index)), "lines": .array((0 ..< inner).map { item in
                .object(["sku": .number(Double(item))])
            }),
        ]) }
        return try JSONEncoder().encode(JSONValue.object([
            "id": .string("boundary"), "window": .object(["placement": .object(["type": .string("fullscreen")])]),
            "data": .object(["orders": .array(rows)]), "root": .object([
                "type": .string("column"), "repeat": .object([
                    "as": .string("order"), "items": .object(["path": .string("/orders")]),
                ]), "children": .array([.object([
                    "type": .string("column"), "repeat": .object([
                        "as": .string("line"), "items": .object(["field": .string("lines")]),
                    ]), "children": .array([node]),
                ])]),
            ]),
        ]))
    }
}
