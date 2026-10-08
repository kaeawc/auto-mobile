import Foundation
@testable import NetworkFilterCore
import XCTest

/// Pins the JSON the daemon parses (src/features/network-filter/NetworkFilterBridge.ts).
final class ControllerContractTests: XCTestCase {
    /// A provider snapshot, decoded rather than built so this suite does not depend
    /// on how `IdentityProbe` or the attribution resolver construct one.
    private let snapshotJSON = #"""
    {"backend":"macos_network_extension","discardedFlows":0,"flows":[{"delegated":true,\#
    "sourceApp":{"auditToken":"AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",\#
    "code":{"executablePath":"/fixture/Fixture.app/Fixture","signingIdentifier":"dev.jasonpearson.automobile.fixture"}},\#
    "sourceProcess":{"auditToken":"AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI="}}],\#
    "limitations":["Fixture snapshot; no network condition is applied."],\#
    "mode":"allow_only","observedFlows":1,"version":2}
    """#

    private func snapshot() throws -> ProbeSnapshot {
        try JSONDecoder().decode(ProbeSnapshot.self, from: Data(snapshotJSON.utf8))
    }

    private func jsonObject(_ result: ControllerResult) throws -> [String: Any] {
        let data = try result.encodedLine()
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func testContractVersionIsTwo() {
        XCTAssertEqual(ControllerContract.version, 2)
        XCTAssertEqual(ControllerContract.commands, ["activate", "status", "snapshot"])
    }

    func testStateWireValuesMatchTheDaemonContract() {
        XCTAssertEqual(
            ControllerState.allCases.map(\.rawValue),
            ["installation_required", "approval_required", "unavailable", "ready"]
        )
    }

    func testResultWithoutSnapshotEncodesExactlyVersionStateAndDetail() throws {
        let result = ControllerResult(state: .approvalRequired, detail: "Approve it")
        let line = try XCTUnwrap(String(data: result.encodedLine(), encoding: .utf8))
        XCTAssertEqual(line, #"{"detail":"Approve it","state":"approval_required","version":2}"#)
        XCTAssertFalse(line.contains("\n"))
    }

    func testReadyResultNestsTheSnapshotWithItsOwnVersion() throws {
        let object = try jsonObject(ControllerResult(state: .ready, detail: "ok", snapshot: snapshot()))
        XCTAssertEqual(object["version"] as? Int, ControllerContract.version)
        XCTAssertEqual(object["state"] as? String, "ready")
        let nested = try XCTUnwrap(object["snapshot"] as? [String: Any])
        XCTAssertEqual(nested["version"] as? Int, 2)
        XCTAssertEqual(nested["mode"] as? String, "allow_only")
        XCTAssertEqual(nested["observedFlows"] as? Int, 1)
    }

    func testResultRoundTripsThroughDecoding() throws {
        let encoded = try ControllerResult(state: .ready, detail: "ok", snapshot: snapshot()).encodedLine()
        let decoded = try JSONDecoder().decode(ControllerResult.self, from: encoded)
        XCTAssertEqual(decoded.version, ControllerContract.version)
        XCTAssertEqual(decoded.state, .ready)
        XCTAssertEqual(decoded.detail, "ok")
        XCTAssertEqual(decoded.snapshot?.mode, "allow_only")
    }

    func testUnknownStateIsRejectedByDecoding() {
        let line = Data(#"{"detail":"x","state":"installed","version":2}"#.utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(ControllerResult.self, from: line))
    }

    // MARK: - Cross-language fixtures (test/fixtures/network-filter-controller)

    /// Exactly what the controller prints for each state, built with the production encoder.
    private func fixtureResults() throws -> [String: ControllerResult] {
        try [
            "installation-required": ControllerResult(
                state: .installationRequired,
                detail: "A signed containing app and provider provisioning profiles are required."
            ),
            "approval-required": ControllerResult(
                state: .approvalRequired,
                detail: "Approve AutoMobile Network Identity Probe in System Settings, then run activate again."
            ),
            "unavailable": ControllerResult(
                state: .unavailable,
                detail: "Operation timed out; installation may have completed. Run status to reconcile."
            ),
            "ready": ControllerResult(
                state: .ready,
                detail: "Allow-only provider replied; traffic isolation and shaping remain unverified.",
                snapshot: snapshot()
            ),
        ]
    }

    private var fixtureDirectory: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // NetworkFilterCoreTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // network-filter
            .deletingLastPathComponent() // ios
            .deletingLastPathComponent() // repository root
            .appendingPathComponent("test/fixtures/network-filter-controller")
    }

    /// Regenerate with the command in test/fixtures/network-filter-controller/README.md.
    func testCommittedFixturesMatchTheEncoder() throws {
        let outputDirectory = ProcessInfo.processInfo.environment["AUTOMOBILE_FIXTURE_OUT_DIR"]
        for (name, result) in try fixtureResults() {
            var line = try result.encodedLine()
            line.append(10)
            if let outputDirectory {
                try line.write(to: URL(fileURLWithPath: outputDirectory).appendingPathComponent("\(name).json"))
            }
            let committed = try Data(contentsOf: fixtureDirectory.appendingPathComponent("\(name).json"))
            XCTAssertEqual(committed, line, "\(name).json drifted from ControllerResult encoding")
        }
    }
}
