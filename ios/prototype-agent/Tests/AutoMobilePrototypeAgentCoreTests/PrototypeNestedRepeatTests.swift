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

    static let fixtureFiles = ["nested.json", "nested-sources.json"]

    static func fixtures() throws -> [Fixture] {
        try fixtureFiles.flatMap { file in
            try JSONDecoder().decode([Fixture].self, from: Data(
                contentsOf: PrototypeSpecFixtures.directory.appendingPathComponent("repeat/\(file)")
            ))
        }
    }

    func testAllSharedValidFixtures() throws {
        let fixtures = try Self.fixtures()
        let expectedCount = try Self.fixtureFiles.reduce(0) { count, file in
            try count + JSONDecoder().decode([JSONValue].self, from: Data(
                contentsOf: PrototypeSpecFixtures.directory.appendingPathComponent("repeat/\(file)")
            )).count
        }
        XCTAssertFalse(fixtures.isEmpty)
        XCTAssertEqual(fixtures.count, expectedCount)
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
        XCTAssertFalse(files.isEmpty)
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

    func testSharedCellFixtureReachesExactContractLimit() throws {
        func cells(_ spec: JSONValue) throws -> Int {
            let fields = try XCTUnwrap(spec.objectFields)
            let data = try XCTUnwrap(fields["data"]?.objectFields)
            var values = PrototypeRepeatData(data: data)
            guard case let .array(orders)? = data["orders"],
                  let outer = orders.first?.objectFields,
                  case let .array(children)? = fields["root"]?.objectFields?["children"]
            else {
                XCTFail("Missing boundary rows"); return 0
            }
            return try children.reduce(values.cells("/orders")) { total, child in
                let items = child.objectFields?["repeat"]?.objectFields?["items"]?.objectFields
                let field = try XCTUnwrap(items?["field"]?.stringValue)
                var inner = try PrototypeRepeatData(data: ["rows": XCTUnwrap(outer[field])])
                return total + inner.cells("/rows")
            }
        }
        let valid = try Data(
            contentsOf:
            PrototypeSpecFixtures.directory.appendingPathComponent("repeat/nested-cell-limit.json")
        )
        XCTAssertEqual(try cells(JSONDecoder().decode(JSONValue.self, from: valid)), PrototypeLimits.maxRepeatPathCells)
        XCTAssertNoThrow(try PrototypeSpecStrictValidator.validate(data: valid))
        let invalid = try JSONDecoder().decode(JSONValue.self, from: Data(
            contentsOf:
            PrototypeSpecFixtures.directory.appendingPathComponent("invalid/nested-repeat-cell-limit.json")
        ))
        XCTAssertEqual(try cells(XCTUnwrap(invalid.objectFields?["spec"])), PrototypeLimits.maxRepeatPathCells + 1)
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

    func testOrdinaryRepeatsDoNotRequireNestedCapability() throws {
        for items in [#"[{"n":1}]"#, #"{"path":"/rows"}"#, #"{"derived":"rows"}"#] {
            let root = try JSONDecoder().decode(JSONValue.self, from: Data("""
            {"type":"column","repeat":{"as":"item","items":\(items),"key":"shown","derive":{
              "shown":{"of":{"item":"n"},"format":{"number":{}}}}},
              "children":[{"type":"checkbox","stateKey":"s{item.shown}"}]}
            """.utf8))
            let required = PrototypeStrictCapabilities.required(["root": root])
            XCTAssertFalse(required.contains(PrototypeAgentProtocol.nestedRepeatCapability), items)
        }
    }

    func testUnusedLiteralArraysRequireNestedCapabilityInBothGates() throws {
        let data = try Data(
            contentsOf: PrototypeSpecFixtures.directory
                .appendingPathComponent("repeat/nested-literal-unused-array.json")
        )
        let spec = try JSONDecoder().decode(JSONValue.self, from: data)
        let required = PrototypeStrictCapabilities.required(spec.objectFields ?? [:])
        let capability = PrototypeAgentProtocol.nestedRepeatCapability
        XCTAssertTrue(required.contains(capability))
        XCTAssertTrue(try PrototypeBundleCapabilities.required(data).contains(capability))
        XCTAssertNoThrow(try PrototypeSpecStrictValidator.validate(data: data, supportedCapabilities: required))
        XCTAssertThrowsError(try PrototypeSpecStrictValidator.validate(
            data: data, supportedCapabilities: required.subtracting([capability])
        )) { error in
            XCTAssertEqual(error as? PrototypeLoadError, .invalidSpec(
                path: "$", message: "Unsupported capabilities: prototype_nested_repeat_v1"
            ))
        }
    }

    func testEmptyOuterSourcesKeepInnerStateKeyScopes() throws {
        let node = try JSONDecoder().decode(JSONValue.self, from: Data(#"""
        {"type":"checkbox","stateKey":"checked_{line.id}","onTap":[
          {"type":"toggle","key":"checked_{line.id}"},{"type":"increment","key":"count_{line.id}"}]}
        """#.utf8))
        for outer in [0, 1] {
            XCTAssertNoThrow(try PrototypeSpecStrictValidator.validate(data: nestedSpec(
                outer: outer,
                inner: 0,
                node: node
            )))
        }
    }

    func testNestedEmitStateKeysBindBothIndices() throws {
        let node = try JSONDecoder().decode(JSONValue.self, from: Data(#"""
        {"type":"text","text":"Emit","onTap":[{"type":"emit","name":"pick",
          "context":{"selected":{"state":"selected_{outerIndex}_{index}"}}}]}
        """#.utf8))
        let spec = try JSONDecoder().decode(JSONValue.self, from: nestedSpec(outer: 2, inner: 2, node: node))
        XCTAssertNoThrow(try PrototypeRepeat.validateEmitContexts(
            XCTUnwrap(spec.objectFields?["root"]), data: spec.objectFields?["data"]?.objectFields
        ))
    }

    func testSubstitutedTextBudgetIsSharedAcrossInnerSiblings() throws {
        let rows = Array(
            repeating: JSONValue.object(["name": .string(String(repeating: "x", count: 16000))]),
            count: 100
        )
        let text = JSONValue.object(["type": .string("text"), "text": .string("{line.name}")])
        func root(_ count: Int) -> JSONValue {
            .object([
                "type": .string("column"), "repeat": .object([
                    "as": .string("order"), "items": .array([.object(["lines": .array(rows)])]),
                ]), "children": .array([.object([
                    "type": .string("column"), "repeat": .object([
                        "as": .string("line"), "items": .object(["field": .string("lines")]),
                    ]), "children": .array(Array(repeating: text, count: count)),
                ])]),
            ])
        }
        XCTAssertNoThrow(try PrototypeLimits.guardSubstitutedText(root(2), data: nil))
        XCTAssertThrowsError(try PrototypeLimits.guardSubstitutedText(root(3), data: nil)) { error in
            XCTAssertTrue("\(error)".contains("Substituted text total limit exceeded"))
        }
    }

    func testDerivedLazyListGuardsNestedSubstitutedTextLength() throws {
        let root = try JSONDecoder().decode(JSONValue.self, from: Data(#"""
        {"type":"list","repeat":{"as":"order","items":{"derived":"orders"},"key":"id"},"children":[
          {"type":"column","repeat":{"as":"line","items":{"field":"lines"}},"children":[
            {"type":"text","text":"{line.name}"}]}]}
        """#.utf8))
        func bound(_ length: Int) -> JSONValue {
            PrototypeDerivedCollections.bind(root, values: ["orders": .array([.object([
                "id": .string("a"), "lines": .array([.object([
                    "name": .string(String(repeating: "x", count: length)),
                ])]),
            ])])])
        }
        XCTAssertNoThrow(try PrototypeLimits.guardSubstitutedText(
            bound(PrototypeLimits.maxSubstitutedTextLength), data: nil
        ))
        XCTAssertThrowsError(try PrototypeLimits.guardSubstitutedText(
            bound(PrototypeLimits.maxSubstitutedTextLength + 1), data: nil
        )) { error in
            XCTAssertTrue("\(error)".contains("Substituted text length limit exceeded"))
        }
    }

    func testNestedEmitBindingsUseScalarProjectionAndRetainCollectionSources() throws {
        let root = try JSONDecoder().decode(JSONValue.self, from: Data(#"""
        {"type":"column","repeat":{"as":"order","items":{"path":"/orders"},"derive":{
          "shown":{"of":{"item":"id"},"format":{"number":{}}}}},"children":[
          {"type":"column","repeat":{"as":"line","items":{"field":"lines"},"derive":{
            "shown":{"of":{"item":"sku"},"format":{"number":{}}}}},"children":[
            {"type":"text","text":"Emit","onTap":[{"type":"emit","name":"pick","context":{
              "id":{"state":"{line.sku}"},"parent":{"state":"{order.id}"},
              "shown":{"state":"{line.shown}"},"parentShown":{"state":"{order.shown}"}}}]}]}]}
        """#.utf8))
        let data: [String: JSONValue] = ["orders": .array([.object([
            "id": .number(1), "object": .object(["x": .number(1)]),
            "shown": .object([:]), "lines": .array([.object([
                "sku": .number(2), "object": .object(["x": .number(2)]), "shown": .object([:]),
            ])]),
        ])])]
        XCTAssertNoThrow(try PrototypeRepeat.validateEmitContexts(root, data: data))
        let text = try XCTUnwrap(String(data: JSONEncoder().encode(root), encoding: .utf8))
        for (reference, field) in [
            ("line.object", "object"), ("order.object", "outer.object"), ("order.lines", "outer.lines"),
        ] {
            let invalid = try JSONDecoder().decode(JSONValue.self, from: Data(
                text.replacingOccurrences(of: "{line.sku}", with: "{\(reference)}").utf8
            ))
            XCTAssertThrowsError(try PrototypeRepeat.validateEmitContexts(invalid, data: data)) { error in
                guard case let DecodingError.dataCorrupted(context) = error else { return XCTFail("\(error)") }
                XCTAssertEqual(
                    context.debugDescription,
                    "root.children[0].children[0].onTap[0].context.id.state: Unknown repeat field \"\(field)\""
                )
            }
        }
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
