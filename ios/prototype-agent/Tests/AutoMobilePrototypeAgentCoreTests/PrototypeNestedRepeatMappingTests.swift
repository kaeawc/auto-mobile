@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeNestedRepeatMappingTests: XCTestCase {
    override class func setUp() {
        super.setUp()
        do {
            let fixture = try XCTUnwrap(PrototypeNestedRepeatTests.fixtures().first)
            _ = try JSONDecoder().decode(PrototypeSpec.self, from: fixture.envelope())
        } catch { XCTFail("Could not initialize mapping: \(error)") }
    }

    func testSharedFixturesExpandToExpectedRows() throws {
        for fixture in try PrototypeNestedRepeatTests.fixtures() {
            let spec = try JSONDecoder().decode(PrototypeSpec.self, from: fixture.envelope())
            var rows: [PrototypeNestedRepeatTests.Fixture.Row] = []
            for (outerIndex, container) in (spec.root.children ?? []).enumerated() {
                // Compare drawn text: expanded row values keep their shield until drawn (#18628).
                let texts = (container.children ?? []).compactMap(\.text)
                    .map(PrototypeTextShield.unshield)
                let width = fixture.expected.rows.first?.texts.count ?? 1
                for offset in stride(from: 0, to: texts.count, by: width) {
                    rows.append(.init(
                        outerIndex: outerIndex,
                        innerIndex: offset / width,
                        texts: Array(texts[offset ..< min(offset + width, texts.count)])
                    ))
                }
            }
            XCTAssertEqual(rows, fixture.expected.rows, fixture.name)
            if fixture.state != nil {
                XCTAssertEqual(spec.root.children?[0].children?[1].stateKey, "selected_A_0_PEN_0")
                XCTAssertEqual(spec.root.children?[2].children?[1].stateKey, "selected_C_2_PAD_0")
            }
        }
    }

    func testRepresentativeOrdersKeepOneCardAndHeaderPerOrder() throws {
        let data = try Data(
            contentsOf: PrototypeSpecFixtures.directory
                .appendingPathComponent("repeat/nested-orders.json")
        )
        try PrototypeSpecStrictValidator.validate(data: data)
        let spec = try JSONDecoder().decode(PrototypeSpec.self, from: data)
        let cards = try XCTUnwrap(spec.root.children)
        XCTAssertEqual(cards.map(\.type), ["card", "card"])
        XCTAssertEqual(cards.compactMap { $0.children?.first?.text }, ["Order A #0 Ada", "Order C #1 Cy"])
        XCTAssertEqual(cards[0].children?[1].children?.compactMap(\.text), ["PEN x2 (A 0.0)", "INK x1 (A 0.1)"])
        XCTAssertEqual(cards[1].children?[1].children?.compactMap(\.text), ["PAD x3 (C 1.0)"])
    }

    func testLazyOuterListExpandsEachInnerRow() throws {
        let fixture = try XCTUnwrap(PrototypeNestedRepeatTests.fixtures().first)
        var fields = try XCTUnwrap(JSONDecoder().decode(JSONValue.self, from: fixture.envelope()).objectFields)
        var root = try XCTUnwrap(fields["root"]?.objectFields)
        var repeated = try XCTUnwrap(root["repeat"]?.objectFields)
        repeated["key"] = .string("id")
        root["type"] = .string("list")
        root["repeat"] = .object(repeated)
        fields["root"] = .object(root)
        let data = try JSONEncoder().encode(JSONValue.object(fields))
        try PrototypeSpecStrictValidator.validate(data: data)
        let spec = try JSONDecoder().decode(PrototypeSpec.self, from: data)
        let first = try XCTUnwrap(PrototypeLazyList.row(node: spec.root, data: spec.data, index: 0))
        let empty = try XCTUnwrap(PrototypeLazyList.row(node: spec.root, data: spec.data, index: 1))
        let last = try XCTUnwrap(PrototypeLazyList.row(node: spec.root, data: spec.data, index: 2))
        XCTAssertEqual(first.node.children?.compactMap(\.text), ["0/0 A Ada: PEN x2", "0/1 A Ada: INK x1"])
        XCTAssertEqual(empty.node.children?.count, 0)
        XCTAssertEqual(last.node.children?.compactMap(\.text), ["2/0 C Cy: PAD x3"])
    }

    private func identitySpec(_ ids: [String], outerKey: Bool = true, innerKey: Bool = true) throws -> PrototypeSpec {
        let fixture = try XCTUnwrap(PrototypeNestedRepeatTests.fixtures().first)
        var fields = try XCTUnwrap(JSONDecoder().decode(JSONValue.self, from: fixture.envelope()).objectFields)
        var root = try XCTUnwrap(fields["root"]?.objectFields)
        var repeatSpec = try XCTUnwrap(root["repeat"]?.objectFields)
        repeatSpec["key"] = outerKey ? .string("id") : nil
        root["repeat"] = .object(repeatSpec)
        guard case let .array(children)? = root["children"], var inner = children[0].objectFields,
              var nested = inner["repeat"]?.objectFields
        else { throw PrototypeLoadError.invalidSpec(path: "root", message: "Missing template") }
        nested["key"] = innerKey ? .string("sku") : nil
        inner["repeat"] = .object(nested)
        inner["children"] = .array([
            .object(["type": .string("text"), "text": .string("{order.id}/{line.sku}")]),
            .object(["type": .string("text"), "text": .string("second {line.sku}")]),
        ])
        root["children"] = .array([.object(inner)])
        fields["root"] = .object(root)
        fields["data"] = .object(["orders": .array(ids.map { id in .object([
            "id": .string(id), "lines": .array([.object(["sku": .string("shared")])]),
        ]) })])
        let data = try JSONEncoder().encode(JSONValue.object(fields))
        try PrototypeSpecStrictValidator.validate(data: data)
        return try JSONDecoder().decode(PrototypeSpec.self, from: data)
    }

    func testComposedForEachIdentitySurvivesOuterReorderAndInsertion() throws {
        func identities(_ ids: [String]) throws -> [String: [String]] {
            let spec = try identitySpec(ids)
            let outer = spec.root.drawnChildren(holds: { _ in true })
            return try Dictionary(uniqueKeysWithValues: outer.map { entry in
                let key = try XCTUnwrap(entry.node.repeatKey)
                let rows = entry.node.drawnChildren(holds: { _ in true })
                XCTAssertEqual(
                    rows.map(\.node.repeatIdentity),
                    ["\(key)/shared/children[0]", "\(key)/shared/children[1]"]
                )
                XCTAssertEqual(rows.first?.node.repeatKey, "\(key)/shared")
                return (key, [entry.identity] + rows.map(\.identity))
            })
        }
        let before = try identities(["A", "B"])
        let reordered = try identities(["B", "A"])
        let inserted = try identities(["NEW", "B", "A"])
        XCTAssertEqual(before, reordered)
        XCTAssertEqual(before["A"], inserted["A"])
        XCTAssertEqual(before["B"], inserted["B"])
        let all = inserted.values.flatMap { $0 }
        XCTAssertEqual(Set(all).count, all.count)
    }

    func testComposedIdentityFallsBackOnlyForUndeclaredKeys() throws {
        let innerPositional = try identitySpec(["A", "B"], innerKey: false)
        XCTAssertEqual(innerPositional.root.children?[0].children?[0].repeatIdentity, "A/0/children[0]")
        XCTAssertEqual(innerPositional.root.children?[1].children?[0].repeatIdentity, "B/0/children[0]")
        let outerPositional = try identitySpec(["A", "B"], outerKey: false)
        XCTAssertEqual(outerPositional.root.children?[0].children?[0].repeatIdentity, "0/shared/children[0]")
        XCTAssertEqual(outerPositional.root.children?[1].children?[0].repeatIdentity, "1/shared/children[0]")
    }

    func testExpansionIdentityIsInternalMetadata() throws {
        let node: JSONValue = .object([
            "type": .string("column"), PrototypeRepeat.identityField: .string("A/children[0]"),
            "children": .array([.object([
                "type": .string("text"), "text": .string("row"),
                PrototypeRepeat.rowKeyField: .string("A/shared"),
                PrototypeRepeat.identityField: .string("A/shared/children[0]"),
            ])]),
        ])
        XCTAssertEqual(PrototypeRepeat.withoutRowKeys(node), .object([
            "type": .string("column"),
            "children": .array([.object(["type": .string("text"), "text": .string("row")])]),
        ]))
        let spec: JSONValue = .object([
            "id": .string("authored-identity"),
            "window": .object(["placement": .object(["type": .string("fullscreen")])]),
            "root": node,
        ])
        XCTAssertThrowsError(try PrototypeSpecStrictValidator.validate(data: JSONEncoder().encode(spec))) { error in
            XCTAssertEqual(error as? PrototypeLoadError, .invalidSpec(
                path: "root._repeatIdentity", message: "Unknown property"
            ))
        }
    }

    func testDataWriteRebuildsNestedRows() throws {
        let fixture = try XCTUnwrap(PrototypeNestedRepeatTests.fixtures().first)
        let original = try JSONDecoder().decode(PrototypeSpec.self, from: fixture.envelope())
        var data = try XCTUnwrap(original.data)
        data["orders"] = .array([.object([
            "id": .string("Z"), "customer": .string("Zoe"),
            "lines": .array([.object(["sku": .string("NEW"), "qty": .number(4)])]),
        ])])
        let rebuilt = try original.replacingData(data)
        XCTAssertEqual(rebuilt.root.children?.count, 1)
        XCTAssertEqual(rebuilt.root.children?.first?.children?.first?.text, "0/0 Z Zoe: NEW x4")
        XCTAssertEqual(original.root.children?.count, 3)
    }
}
