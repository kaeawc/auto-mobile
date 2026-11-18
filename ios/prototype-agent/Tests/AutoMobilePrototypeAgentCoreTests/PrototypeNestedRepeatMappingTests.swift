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
                let texts = (container.children ?? []).compactMap(\.text)
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
