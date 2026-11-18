@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeDeriveTests: XCTestCase {
    override class func setUp() {
        super.setUp()
        do { _ = try PrototypeDerivedCollections.entries(.object([:])) }
        catch { XCTFail("Could not initialize contract: \(error)") }
    }

    private struct Fixture: Decodable {
        let name: String
        let spec: JSONValue?
        let derive: JSONValue?
        let data: [String: JSONValue]?
        let state: [String: JSONValue]?
        let expected: [String: JSONValue]?
        let error: Failure?
        let changes: [Change]?
        struct Failure: Decodable { let path: String; let message: String }
        struct Change: Decodable {
            let state: [String: JSONValue]?
            let data: [String: JSONValue]?
            let expectRecomputed: [String]
        }
    }

    private func fixtures() throws -> [Fixture] {
        try JSONDecoder().decode([Fixture].self, from: Data(
            contentsOf:
            PrototypeSpecFixtures.directory.appendingPathComponent("derive/collections.json")
        ))
    }

    func testAllSharedCollectionFixtures() throws {
        let cases = try fixtures()
        XCTAssertEqual(cases.count, 35)
        XCTAssertEqual(cases.filter { $0.error != nil }.count, 12)
        for fixture in cases where fixture.error == nil {
            let entries = try PrototypeDerivedCollections.entries(fixture.spec?.objectFields?["derive"])
            var data = fixture.data ?? [:], state = fixture.state ?? [:]
            var values = PrototypeDerive.evaluate(entries, data: data, state: state)
            XCTAssertEqual(values, fixture.expected, fixture.name)
            for change in fixture.changes ?? [] {
                let observer = Observer()
                let pointers = Set((change.data ?? [:]).keys.map {
                    "/" + $0.replacingOccurrences(of: "~", with: "~0").replacingOccurrences(of: "/", with: "~1")
                })
                data.merge(change.data ?? [:]) { _, new in new }
                state.merge(change.state ?? [:]) { _, new in new }
                values = PrototypeDerive.evaluate(
                    entries, data: data, state: state, previous: values,
                    changed: PrototypeDeriveChanges(
                        dataPointers: pointers,
                        stateKeys: Set(change.state?.keys ?? [:].keys)
                    ),
                    observer: observer
                )
                XCTAssertEqual(Set(observer.names), Set(change.expectRecomputed), fixture.name)
                XCTAssertEqual(values, PrototypeDerive.evaluate(entries, data: data, state: state), fixture.name)
            }
        }
    }

    func testSharedValidationErrorsHaveExactPathsAndMessages() throws {
        for fixture in try fixtures() {
            guard let failure = fixture.error, let derive = fixture.derive else { continue }
            let spec: JSONValue = .object([
                "id": .string("collections"), "derive": derive,
                "window": .object(["placement": .object(["type": .string("fullscreen")])]),
                "root": .object(["type": .string("text"), "text": .string("ok")]),
            ])
            XCTAssertThrowsError(try PrototypeSpecStrictValidator.validate(data: JSONEncoder().encode(spec))) { error in
                guard case let PrototypeLoadError.invalidSpec(path, message) = error else {
                    return XCTFail("\(fixture.name): \(error)")
                }
                XCTAssertEqual(path, failure.path, fixture.name)
                XCTAssertEqual(message, failure.message, fixture.name)
            }
        }
    }

    func testSourceCapPreservesOriginalRowsAndOnlyAffectedInputsRecompute() throws {
        let entries = try decode(#"""
        {"rows":{"collection":{"of":{"data":"/catalog/rows"}}},
         "query":{"of":{"state":"query"},"format":{"number":{}}},
         "constant":{"of":{"value":4},"format":{"number":{}}}}
        """#)
        let row: JSONValue = .object(["id": .number(1), "nested": .object(["keep": .bool(true)])])
        let data: [String: JSONValue] = ["catalog": .object(["rows": .array(Array(repeating: row, count: 501))])]
        let initial = PrototypeDerive.evaluate(entries, data: data, state: [:])
        XCTAssertEqual(initial["rows"], .array(Array(repeating: row, count: 500)))
        for path in ["/catalog", "/catalog/rows", "/catalog/rows/0/id", ""] {
            let observer = Observer()
            _ = PrototypeDerive.evaluate(
                entries,
                data: data,
                state: [:],
                previous: initial,
                changed: PrototypeDeriveChanges(dataPointers: [path]),
                observer: observer
            )
            XCTAssertEqual(observer.names, ["rows"])
        }
        let observer = Observer()
        _ = PrototypeDerive.evaluate(
            entries,
            data: data,
            state: [:],
            previous: initial,
            changed: PrototypeDeriveChanges(dataPointers: ["/catalogue"], stateKeys: ["other"]),
            observer: observer
        )
        XCTAssertTrue(observer.names.isEmpty)
        _ = PrototypeDerive.evaluate(
            entries,
            data: data,
            state: ["query": .number(3)],
            previous: initial,
            changed: PrototypeDeriveChanges(stateKeys: ["query"]),
            observer: observer
        )
        XCTAssertEqual(observer.names, ["query"])
    }

    func testContainsIsLiteralUnicodeAndMissingLastForDescendingMixedSort() throws {
        let entries = try decode(#"""
        {"filtered":{"collection":{"of":{"data":"/rows"},"where":[
          {"field":"name","op":"contains","value":{"value":"é"}}]}},
         "sorted":{"collection":{"of":{"data":"/rows"},"sort":{"field":"n","order":"desc"}}}}
        """#)
        let rows: [JSONValue] = [
            .object(["name": .string("e\u{0301}")]),
            .object(["name": .string("É"), "n": .number(1)]),
            .object(["n": .string("z")]),
            .object(["n": .number(3)]),
        ]
        let values = PrototypeDerive.evaluate(entries, data: ["rows": .array(rows)], state: [:])
        XCTAssertEqual(values["filtered"], .array([rows[1]]))
        XCTAssertEqual(values["sorted"], .array([rows[2], rows[3], rows[1], rows[0]]))
    }

    private func decode(_ text: String) throws -> [String: PrototypeDerivedEntry] {
        try JSONDecoder().decode([String: PrototypeDerivedEntry].self, from: Data(text.utf8))
    }

    func testDerivedInvalidationDistinguishesCanonicallyEquivalentStrings() {
        let composed = JSONValue.string("\u{E9}")
        let decomposed = JSONValue.string("e\u{301}")
        XCTAssertEqual(composed, decomposed)
        XCTAssertFalse(PrototypeSession.scalarIdentical(composed, decomposed))
        XCTAssertFalse(PrototypeSession.scalarIdentical(.array([composed]), .array([decomposed])))
        XCTAssertTrue(PrototypeSession.scalarIdentical(.object(["q": composed]), .object(["q": composed])))
        XCTAssertTrue(PrototypeSession.scalarIdentical(nil, nil))
    }

    private final class Observer: PrototypeDeriveObserver {
        var names: [String] = []
        func recomputed(name: String) { names.append(name) }
    }
}
