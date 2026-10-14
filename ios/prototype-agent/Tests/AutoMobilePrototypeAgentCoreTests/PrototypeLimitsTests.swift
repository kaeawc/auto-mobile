@testable import AutoMobilePrototypeAgentCore
import XCTest

/// The agent-side backstop for the structural limits (#11049): a spec that skips the host
/// validator is still refused, on the same shared boundary fixtures TypeScript and Kotlin use.
final class PrototypeLimitsTests: XCTestCase {
    private var fixtureRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test/fixtures/prototype-spec")
    }

    private func data(_ path: String) throws -> Data {
        try Data(contentsOf: fixtureRoot.appendingPathComponent(path))
    }

    private func rejection(_ spec: Data) -> String? {
        do {
            _ = try JSONDecoder().decode(PrototypeSpec.self, from: spec)
            return nil
        } catch let DecodingError.dataCorrupted(context) {
            return context.debugDescription
        } catch {
            return "\(error)"
        }
    }

    func testConstantsMatchTheSharedContract() throws {
        let contract = try JSONSerialization.jsonObject(
            with: Data(
                contentsOf: fixtureRoot.deletingLastPathComponent().deletingLastPathComponent()
                    .deletingLastPathComponent().appendingPathComponent("schemas/prototype-spec-contract.json")
            )
        ) as? [String: Any]
        let limits = try XCTUnwrap(contract?["limits"] as? [String: Int])
        XCTAssertEqual(PrototypeLimits.maxNodes, limits["MAX_PROTOTYPE_NODES"])
        XCTAssertEqual(PrototypeLimits.maxDepth, limits["MAX_PROTOTYPE_DEPTH"])
        XCTAssertEqual(PrototypeLimits.maxSpecBytes, limits["MAX_PROTOTYPE_SPEC_BYTES"])
        let definitions = try XCTUnwrap(contract?["definitions"] as? [String: Any])
        let repeatFields = try XCTUnwrap((definitions["repeat"] as? [String: Any])?["fields"] as? [String: Any])
        let items = try XCTUnwrap((repeatFields["items"] as? [String: Any])?["rule"] as? [String: Any])
        let options = try XCTUnwrap(items["options"] as? [[String: Any]])
        let literal = try XCTUnwrap(options.first { $0["kind"] as? String == "array" })
        XCTAssertEqual(PrototypeLimits.maxRepeatItems, literal["max"] as? Int)
        XCTAssertEqual(PrototypeLimits.maxDataDepth, limits["MAX_PROTOTYPE_DATA_DEPTH"])
        XCTAssertEqual(PrototypeLimits.maxDataArrayItems, limits["MAX_PROTOTYPE_DATA_ARRAY_ITEMS"])
        XCTAssertEqual(PrototypeLimits.maxDataPointerLength, limits["MAX_PROTOTYPE_DATA_POINTER_LENGTH"])
        XCTAssertEqual(PrototypeLimits.maxDataBytes, limits["MAX_PROTOTYPE_DATA_BYTES"])
        XCTAssertEqual(PrototypeLimits.maxRepeatPathCells, limits["MAX_PROTOTYPE_REPEAT_PATH_CELLS"])
    }

    func testExactLimitFixturesDecode() throws {
        for name in ["exact-node-limit", "repeat-exact-node-limit", "exact-depth-limit"] {
            XCTAssertNil(try rejection(data("valid/\(name).json")), name)
        }
    }

    func testOverLimitFixturesAreRefusedAtTheValidatorPath() throws {
        let expected: [String: String] = [
            "node-limit": "root.children[1999]: Node limit exceeded",
            "repeat-too-many-items": "root.repeat.items: Repeat item limit exceeded",
            "depth-limit": "Tree depth limit exceeded",
        ]
        for (name, message) in expected {
            let wrapper = try XCTUnwrap(
                JSONSerialization
                    .jsonObject(with: data("invalid/\(name).json")) as? [String: Any]
            )
            let spec = try JSONSerialization.data(withJSONObject: XCTUnwrap(wrapper["spec"]))
            let reason = try XCTUnwrap(rejection(spec), name)
            XCTAssertTrue(reason.contains(message), "\(name): \(reason)")
        }
    }

    func testExpandedRepeatOverTheNodeLimitIsRefusedBeforeExpansion() throws {
        let wrapper = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data("invalid/repeat-node-limit-expanded.json")) as? [String: Any]
        )
        let spec = try JSONSerialization.data(withJSONObject: XCTUnwrap(wrapper["spec"]))
        let reason = try XCTUnwrap(rejection(spec))
        XCTAssertTrue(reason.hasSuffix("Node limit exceeded"), reason)
        XCTAssertTrue(reason.hasPrefix("root.children[79].repeat["), reason)
    }

    private func pathRepeatSpec(_ root: JSONValue) throws -> Data {
        // Data deliberately absent: authored limits must not depend on pointer resolution.
        try JSONEncoder().encode(JSONValue.object([
            "id": .string("authored"),
            "window": .object(["placement": .object(["type": .string("fullscreen")])]),
            "root": root,
        ]))
    }

    func testAuthoredPathRepeatsExceedNodeLimitWithoutData() throws {
        let column: JSONValue = .object([
            "type": .string("column"), "children": .array([]),
            "repeat": .object(["items": .object(["path": .string("/missing")]), "as": .string("item")]),
        ])
        let root: JSONValue = .object([
            "type": .string("column"), "children": .array(Array(repeating: column, count: 2001)),
        ])
        XCTAssertEqual(try rejection(pathRepeatSpec(root)), "root.children[1999]: Node limit exceeded")
    }

    func testAuthoredPathRepeatTemplateDepthLimitWithoutData() throws {
        var template: JSONValue = .object(["type": .string("text"), "text": .string("leaf")])
        for _ in 0 ..< 23 {
            template = .object(["type": .string("scroll"), "child": template])
        }
        let root: JSONValue = .object([
            "type": .string("column"), "children": .array([template]),
            "repeat": .object(["items": .object(["path": .string("/missing")]), "as": .string("item")]),
        ])
        XCTAssertEqual(
            try rejection(pathRepeatSpec(root)),
            "root.children[0]" + String(repeating: ".child", count: 23) + ": Tree depth limit exceeded"
        )
    }
}
