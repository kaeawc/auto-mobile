@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypePatchTests: XCTestCase {
    private struct Fixture: Decodable {
        let spec: JSONValue
        let ops: JSONValue
        let stateTests: String?
        let expected: JSONValue?
        let stage: String?
        let expectedPath: String?
        let expectedMessage: String?
    }

    private var fixtureRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test/fixtures/prototype-spec/patch")
    }

    func testEverySharedFixture() throws {
        let files = try FileManager.default.contentsOfDirectory(at: fixtureRoot, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "json" }.sorted { $0.lastPathComponent < $1.lastPathComponent }
        XCTAssertGreaterThanOrEqual(files.count, 45, "Shared patch fixture directory")
        // Decode each file once; the test then executes the already-loaded immutable values.
        let fixtures = try files.map { file in
            try (file.lastPathComponent, JSONDecoder().decode(Fixture.self, from: Data(contentsOf: file)))
        }
        for (name, fixture) in fixtures {
            let result = PrototypePatch.apply(
                spec: fixture.spec, ops: fixture.ops, stateTests: fixture.stateTests == "skip" ? .skip : .evaluate
            )
            if fixture.stage == "apply" {
                let path = try XCTUnwrap(fixture.expectedPath, name)
                let message = try XCTUnwrap(fixture.expectedMessage, name)
                XCTAssertEqual(result, .failure(PrototypePatch.Failure(path: path, message: message)), name)
            } else if fixture.stage == "validate" {
                guard case .success = result else { XCTFail("\(name): \(result)"); continue }
            } else {
                let expected = try XCTUnwrap(fixture.expected, name)
                XCTAssertEqual(result, .success(expected), name)
            }
        }
    }

    func testOpCountBoundaryAndLimit() {
        XCTAssertEqual(PrototypeLimits.maxPatchOps, 64)
        let spec: JSONValue = .object(["data": .object([:])])
        let operation: JSONValue = .object(["op": .string("test"), "path": .string("/data"), "value": .object([:])])
        XCTAssertEqual(
            PrototypePatch.apply(spec: spec, ops: .array(Array(repeating: operation, count: 64))),
            .success(spec)
        )
        XCTAssertEqual(
            PrototypePatch.apply(spec: spec, ops: .array(Array(repeating: operation, count: 65))),
            .failure(PrototypePatch.Failure(path: "ops", message: "Array length out of range"))
        )
    }

    func testTouchesStateIgnoresUnrelatedAndMalformedPaths() {
        for path in ["/state", "/state/a"] {
            XCTAssertTrue(PrototypePatch.touchesState(.array([.object(["path": .string(path)])])), path)
        }
        for path in ["/data/state", "/stateful"] {
            XCTAssertFalse(PrototypePatch.touchesState(.array([.object(["path": .string(path)])])), path)
        }
        XCTAssertFalse(PrototypePatch.touchesState(.object([:])))
        XCTAssertFalse(PrototypePatch.touchesState(.array([
            .null,
            .number(1),
            .object([:]),
            .object(["path": .bool(true)]),
        ])))
    }

    func testPointersUseExactUTF16AndIndicesDoNotOverflow() {
        let spec: JSONValue = .object(["data": .object([
            "é": .number(1), "\u{0301}": .number(2), "items": .array([.number(3)]),
        ])])
        for path in ["/data/e\u{0301}", "/data/items/999999999999999999999999999999"] {
            let operation: JSONValue = .object([
                "op": .string("replace"), "path": .string(path), "value": .number(4),
            ])
            XCTAssertEqual(
                PrototypePatch.apply(spec: spec, ops: .array([operation])),
                .failure(PrototypePatch.Failure(path: "ops[0].path", message: "Path does not exist")), path
            )
        }
        let operation: JSONValue = .object([
            "op": .string("test"), "path": .string("/data/\u{0301}"), "value": .number(2),
        ])
        XCTAssertEqual(PrototypePatch.apply(spec: spec, ops: .array([operation])), .success(spec))
    }

    func testNonObjectSpecFailsFirst() {
        XCTAssertEqual(
            PrototypePatch.apply(spec: .null, ops: .null),
            .failure(PrototypePatch.Failure(path: "$", message: "Expected object"))
        )
    }
}
