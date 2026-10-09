@testable import AutoMobileOverlayAgentCore
import XCTest

/// The agent-side backstop for the structural limits (#11049): a spec that skips the host
/// validator is still refused, on the same shared boundary fixtures TypeScript and Kotlin use.
final class OverlayLimitsTests: XCTestCase {
    private var fixtureRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test/fixtures/overlay-spec")
    }

    private func data(_ path: String) throws -> Data {
        try Data(contentsOf: fixtureRoot.appendingPathComponent(path))
    }

    private func rejection(_ spec: Data) -> String? {
        do {
            _ = try JSONDecoder().decode(OverlaySpec.self, from: spec)
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
                    .deletingLastPathComponent().appendingPathComponent("schemas/overlay-spec-contract.json")
            )
        ) as? [String: Any]
        let limits = try XCTUnwrap(contract?["limits"] as? [String: Int])
        XCTAssertEqual(OverlayLimits.maxNodes, limits["MAX_OVERLAY_NODES"])
        XCTAssertEqual(OverlayLimits.maxDepth, limits["MAX_OVERLAY_DEPTH"])
        let definitions = try XCTUnwrap(contract?["definitions"] as? [String: Any])
        let repeatFields = try XCTUnwrap((definitions["repeat"] as? [String: Any])?["fields"] as? [String: Any])
        let items = try XCTUnwrap((repeatFields["items"] as? [String: Any])?["rule"] as? [String: Any])
        XCTAssertEqual(OverlayLimits.maxRepeatItems, items["max"] as? Int)
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
}
