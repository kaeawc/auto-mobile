@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeDerivedCollectionsMappingTests: XCTestCase {
    override class func setUp() {
        super.setUp()
        let json = #"""
        {"id":"warmup","window":{"placement":{"type":"fullscreen"}},
         "derive":{"count":{"collection":{"of":{"data":"/rows"}},"reduce":{"op":"count"}}},
         "root":{"type":"text","text":"{derived:count}"}}
        """#
        do {
            try PrototypeSpecStrictValidator.validate(data: Data(json.utf8))
            _ = try JSONDecoder().decode(PrototypeSpec.self, from: Data(json.utf8))
        } catch { XCTFail("Could not initialize mapping tests: \(error)") }
    }

    private func spec(lazy: Bool = false, count: Int = 3) throws -> PrototypeSpec {
        let template = #"""
        {"id":"catalog","window":{"placement":{"type":"fullscreen"}},"state":{"query":""},
         "data":{},"derive":{
          "results":{"collection":{"of":{"data":"/rows"},"where":[
            {"field":"name","op":"contains","value":{"state":"query"}}]}},
          "count":{"collection":{"of":{"data":"/rows"}},"reduce":{"op":"count"},"format":{"number":{}},"locale":"en-US"},
          "all":{"collection":{"of":{"data":"/rows"}}}},
         "root":{"type":"column","children":[
          {"type":"searchBar","stateKey":"query"},
          {"type":"column","repeat":{"items":{"derived":"results"},"as":"item","key":"id"},
           "children":[{"type":"text","text":"{item.name}"}]}]}}
        """#
        var fields = try XCTUnwrap(JSONDecoder().decode(JSONValue.self, from: Data(template.utf8)).objectFields)
        let rows = (0 ..< count).map { index in JSONValue.object([
            "id": .string("row_\(index)"), "name": .string(index == 1 ? "Beta" : "Alpha \(index)"),
            "nested": .object(["keep": .bool(true)]),
        ]) }
        fields["data"] = .object(["rows": .array(rows)])
        if lazy, var root = fields["root"]?.objectFields,
           case var .array(children)? = root["children"], var list = children[1].objectFields
        {
            list["type"] = .string("list")
            children[1] = .object(list)
            root["children"] = .array(children)
            fields["root"] = .object(root)
        }
        let data = try JSONEncoder().encode(JSONValue.object(fields))
        try PrototypeSpecStrictValidator.validate(data: data)
        return try JSONDecoder().decode(PrototypeSpec.self, from: data)
    }

    func testKeyedRowsKeepIdentityAcrossFilteringAndStateWrites() throws {
        let original = try spec()
        let observer = Observer()
        let filtered = try original.replacingDerivedInputs(
            data: original.data, state: ["query": .string("beta")],
            changed: PrototypeDeriveChanges(stateKeys: ["query"]), observer: observer
        )
        XCTAssertEqual(observer.names, ["results"])
        let before = try XCTUnwrap(original.root.children?[1].children)
        let after = try XCTUnwrap(filtered.root.children?[1].children)
        XCTAssertEqual(after.count, 1)
        XCTAssertEqual(after.first?.repeatKey, before[1].repeatKey)
        XCTAssertEqual(after.first?.text, "Beta")
        var session = PrototypeSession()
        session.show(original)
        _ = session.setStates([("query", .string("beta"))])
        XCTAssertEqual(session.spec?.root.children?[1].children?.first?.repeatKey, before[1].repeatKey)
        _ = session.setStates([("query", .string(""))])
        XCTAssertEqual(session.spec?.root.children?[1].children?.map(\.repeatKey), before.map(\.repeatKey))
        let context = PrototypeDerivedContext(
            entries: filtered.derive ?? [:],
            data: filtered.data,
            values: filtered.derivedValues
        )
        XCTAssertEqual(context.resolve("count", state: [:]), "3")
    }

    func testThreeHundredItemCatalogUsesLazyRowsAndDependencyCache() throws {
        let original = try spec(lazy: true, count: 300)
        let observer = Observer()
        var current = original
        for query in ["b", "be", "bet", "beta", ""] {
            current = try current.replacingDerivedInputs(
                data: current.data, state: ["query": .string(query)],
                changed: PrototypeDeriveChanges(stateKeys: ["query"]), observer: observer
            )
            let list = try XCTUnwrap(current.root.children?[1])
            let keys = PrototypeLazyList.keys(node: list, data: current.data)
            XCTAssertEqual(keys.count, query.isEmpty ? 300 : 1)
            let row = try XCTUnwrap(PrototypeLazyList.row(node: list, data: current.data, index: query.isEmpty ? 1 : 0))
            XCTAssertEqual(row.key, "row_1")
            XCTAssertEqual(row.node.text, "Beta")
        }
        XCTAssertEqual(observer.names, Array(repeating: "results", count: 5))
        XCTAssertEqual(current.derivedValues["all"], original.derivedValues["all"])
    }

    func testUnknownAndReducedRepeatSourcesRejectAtDerivedPath() throws {
        for (name, expected) in [
            ("missing", "Unknown derived value \"missing\""),
            ("count", "Repeat derived items must name a collection without reduce"),
        ] {
            let original = try spec()
            let root = original.authoredRoot
            var fields = try XCTUnwrap(root.objectFields)
            guard case var .array(children)? = fields["children"], var list = children[1].objectFields,
                  var repeated = list["repeat"]?.objectFields else { return XCTFail("Missing repeat") }
            repeated["items"] = .object(["derived": .string(name)])
            list["repeat"] = .object(repeated)
            children[1] = .object(list)
            fields["children"] = .array(children)
            let derive = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(original.derive))
            XCTAssertThrowsError(try PrototypeDerivedValidator.validate(
                derive: derive,
                root: .object(fields),
                data: original.data
            )) { error in
                guard case let PrototypeLoadError.invalidSpec(path, message) = error else { return XCTFail("\(error)") }
                XCTAssertEqual(path, "root.children[1].repeat.items.derived")
                XCTAssertEqual(message, expected)
            }
        }
    }

    func testDataWritesUseCurrentQueryAndInvalidateCollectionInputs() throws {
        var session = PrototypeSession()
        try session.show(spec())
        _ = session.setStates([("query", .string("beta"))])
        let action = try JSONDecoder().decode(PrototypeAction.self, from: Data(#"""
        {"type":"setData","path":"/data/rows/1/name","value":{"value":"Gamma"}}
        """#.utf8))
        _ = session.run([action])
        XCTAssertEqual(session.spec?.root.children?[1].children?.count, 0)
        XCTAssertEqual(session.spec?.derivedValues["results"], .array([]))
        _ = session.setStates([("query", .string("gamma"))])
        XCTAssertEqual(session.spec?.root.children?[1].children?.first?.repeatKey, "row_1")
    }

    func testCapabilityAdvertisementAndRequirements() throws {
        XCTAssertTrue(PrototypeAgentProtocol.capabilities.contains("prototype_derive_v1"))
        XCTAssertTrue(AutoMobilePrototypeCapabilities.supported.contains("prototype_derive_v1"))
        let original = try spec()
        let derive = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(original.derive))
        let fields: [String: JSONValue] = ["derive": derive, "root": original.authoredRoot]
        XCTAssertTrue(PrototypeStrictCapabilities.required(fields).contains("prototype_derive_v1"))
        XCTAssertTrue(
            try PrototypeBundleCapabilities.required(JSONEncoder().encode(JSONValue.object(fields)))
                .contains("prototype_derive_v1")
        )
    }

    private final class Observer: PrototypeDeriveObserver {
        var names: [String] = []
        func recomputed(name: String) { names.append(name) }
    }
}
