@testable import AutoMobilePrototypeAgentCore
import XCTest

/// Style `shimmer` on iOS (#14689): decoded, merged by `styleWhen`, limited to containers like the
/// host and Android, and swept on Android's timing.
final class PrototypeLoadingStatesTests: XCTestCase {
    private var fixtures: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test/fixtures/prototype-spec")
    }

    private func node(_ json: String) throws -> PrototypeNode {
        try JSONDecoder().decode(PrototypeNode.self, from: Data(json.utf8))
    }

    func testTheSharedSkeletonRowDecodesShimmer() throws {
        let spec = try JSONDecoder().decode(
            PrototypeSpec.self,
            from: Data(contentsOf: fixtures.appendingPathComponent("valid/loading-states.json"))
        )
        let row = try XCTUnwrap(spec.root.children?.first?.children?.first)
        XCTAssertEqual(row.type, "row")
        XCTAssertEqual(row.resolvedStyle(state: spec.state ?? [:])?.shimmer, true)
    }

    func testStyleWhenTurnsShimmerOnAndOff() throws {
        let box = try node(#"""
        {"type":"box","style":{"shimmer":true},
         "styleWhen":[{"when":{"key":"loaded","equals":true},"style":{"shimmer":false}}]}
        """#)
        XCTAssertEqual(box.resolvedStyle(state: ["loaded": .bool(false)])?.shimmer, true)
        XCTAssertEqual(box.resolvedStyle(state: ["loaded": .bool(true)])?.shimmer, false)
    }

    func testSharedInvalidFixturesFailAtTheirPath() throws {
        for name in ["shimmer-on-text", "shimmer-on-text-style-when"] {
            let data = try Data(contentsOf: fixtures.appendingPathComponent("invalid/\(name).json"))
            let fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            let expected = try XCTUnwrap(fixture["expectedPath"] as? String)
            let message = try XCTUnwrap(fixture["expectedMessage"] as? String)
            let spec = try JSONSerialization.data(withJSONObject: XCTUnwrap(fixture["spec"]))
            XCTAssertThrowsError(try JSONDecoder().decode(PrototypeSpec.self, from: spec), name) { error in
                XCTAssertTrue("\(error)".contains("\(expected): \(message)"), "\(name): \(error)")
            }
        }
    }

    func testEveryContainerTypeMayShimmer() throws {
        for type in PrototypeLoadingStates.shimmerTypes {
            XCTAssertNoThrow(
                try PrototypeLoadingStates.validate(.object([
                    "type": .string(type), "style": .object(["shimmer": .bool(true)]),
                ])),
                type
            )
        }
    }

    func testTheSweepCrossesFromOneBandBeforeToOneBandAfter() {
        XCTAssertEqual(PrototypeLoadingStates.shimmerCentre(progress: 0, width: 200, band: 100), -100)
        XCTAssertEqual(PrototypeLoadingStates.shimmerCentre(progress: 0.5, width: 200, band: 100), 100)
        XCTAssertEqual(PrototypeLoadingStates.shimmerCentre(progress: 1, width: 200, band: 100), 300)
    }

    func testTheSweepRestartsEveryPeriod() {
        XCTAssertEqual(PrototypeLoadingStates.shimmerProgress(at: 0), 0)
        XCTAssertEqual(PrototypeLoadingStates.shimmerProgress(at: 0.6), 0.5, accuracy: 1e-9)
        XCTAssertEqual(PrototypeLoadingStates.shimmerProgress(at: 1.8), 0.5, accuracy: 1e-9)
        XCTAssertEqual(PrototypeLoadingStates.shimmerProgress(at: -0.6), 0.5, accuracy: 1e-9)
    }
}
