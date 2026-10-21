import Foundation
@testable import NetworkFilterCore
import XCTest

/// Pins the JSON the daemon parses (src/features/networkFilter/NetworkFilterBridge.ts).
final class ControllerContractTests: XCTestCase {
    /// A provider snapshot, decoded rather than built so this suite does not depend
    /// on how `IdentityProbe` or the attribution resolver construct one.
    private let snapshotJSON = #"""
    {"backend":"macos_network_extension","discardedFlows":0,"flows":[{"delegated":true,\#
    "sourceApp":{"auditToken":"AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",\#
    "code":{"executablePath":"/fixture/Fixture.app/Fixture","signingIdentifier":"dev.jasonpearson.automobile.fixture"}},\#
    "sourceProcess":{"auditToken":"AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI="}}],\#
    "limitations":["Fixture snapshot; no network condition is applied."],\#
    "mode":"app_offline","observedFlows":1,\#
    "rules":[{"condition":"offline","droppedFlows":2,"leaseRemainingMilliseconds":14000,\#
    "owner":"fixture-session","ownerGeneration":1759900000000,"revision":3,\#
    "target":{"bundleId":"dev.jasonpearson.automobile.fixture",\#
    "simulator":{"deviceSet":"/fixture/Devices","udid":"DFBF2D27-6674-42EA-AFC4-AB702275D1D4"}}}],\#
    "version":3}
    """#

    private func snapshot() throws -> ProbeSnapshot {
        try JSONDecoder().decode(ProbeSnapshot.self, from: Data(snapshotJSON.utf8))
    }

    private func jsonObject(_ result: ControllerResult) throws -> [String: Any] {
        let data = try result.encodedLine()
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func testContractNewestVersionIsFourAndDefaultIsThree() {
        XCTAssertEqual(ControllerContract.version, 4)
        XCTAssertEqual(ControllerContract.defaultVersion, 3)
        XCTAssertEqual(ControllerContract.supportedVersions, [3, 4])
        XCTAssertEqual(ControllerContract.commands, ["activate", "status", "snapshot", "apply", "reset", "renew"])
    }

    func testRealVersionThreeSnapshotsMatchMainLimitationsAndRuleKeys() throws {
        let limitations = [
            "Simulator attribution methods are unverified on a signed run (#10263).",
            "Offline rules drop new socket flows of one attributed app; established connections continue " +
                "until they close, and unattributed or conflicting flows are always allowed.",
            "Flow history is attributed at read-back: a process that exited since its flow is reported " +
                "as unattributed. Offline verdicts are attributed when each flow arrives.",
            "New socket flows only; non-socket traffic is not filtered.",
            "Code metadata may be absent if a process exits before snapshot collection.",
            "The newest 128 flow identities are retained; no payloads or network addresses are collected.",
        ]
        let offline = try XCTUnwrap(snapshot().rules?.first)
        let probe = IdentityProbe(resolver: FakeIdentityResolver(), processTable: FakeProcessTable())
        for rules in [[], [offline]] {
            let snapshot = probe.snapshot(managedSimulators: [offline.target.simulator], rules: rules, version: 3)
            XCTAssertEqual(snapshot.version, 3)
            XCTAssertEqual(snapshot.mode, rules.isEmpty ? "allow_only" : "app_offline")
            XCTAssertEqual(snapshot.limitations, limitations)
            let data = try JSONEncoder().encode(snapshot)
            let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            XCTAssertEqual(object["version"] as? Int, 3)
            XCTAssertNil(object["shapingActivity"])
            XCTAssertEqual(object["mode"] as? String, rules.isEmpty ? "allow_only" : "app_offline")
            let encodedRules = try XCTUnwrap(object["rules"] as? [[String: Any]])
            XCTAssertEqual(encodedRules.count, rules.count)
            if let rule = encodedRules.first {
                XCTAssertEqual(Set(rule.keys), [
                    "condition", "droppedFlows", "leaseRemainingMilliseconds", "owner", "ownerGeneration",
                    "revision", "target",
                ])
                XCTAssertEqual(rule["condition"] as? String, "offline")
            }
        }
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
        XCTAssertEqual(line, #"{"detail":"Approve it","state":"approval_required","version":3}"#)
        XCTAssertFalse(line.contains("\n"))
    }

    func testReadyResultNestsTheSnapshotWithItsOwnVersion() throws {
        let object = try jsonObject(ControllerResult(state: .ready, detail: "ok", snapshot: snapshot()))
        XCTAssertEqual(object["version"] as? Int, ControllerContract.defaultVersion)
        XCTAssertEqual(object["state"] as? String, "ready")
        let nested = try XCTUnwrap(object["snapshot"] as? [String: Any])
        XCTAssertEqual(nested["version"] as? Int, 3)
        XCTAssertEqual(nested["mode"] as? String, "app_offline")
        XCTAssertEqual(nested["observedFlows"] as? Int, 1)
    }

    func testResultRoundTripsThroughDecoding() throws {
        let encoded = try ControllerResult(state: .ready, detail: "ok", snapshot: snapshot()).encodedLine()
        let decoded = try JSONDecoder().decode(ControllerResult.self, from: encoded)
        XCTAssertEqual(decoded.version, ControllerContract.defaultVersion)
        XCTAssertEqual(decoded.state, .ready)
        XCTAssertEqual(decoded.detail, "ok")
        XCTAssertEqual(decoded.snapshot?.mode, "app_offline")
        XCTAssertEqual(decoded.snapshot?.rules?.first?.revision, 3)
    }

    func testRuleResultIsNestedAndOmittedWhenAbsent() throws {
        let applied = ControllerResult(
            state: .ready,
            detail: "ok",
            rule: NetworkRuleResult(outcome: .applied, installedRevision: 3, leaseRemainingMilliseconds: 15000)
        )
        let object = try jsonObject(applied)
        let rule = try XCTUnwrap(object["rule"] as? [String: Any])
        XCTAssertEqual(rule["outcome"] as? String, "applied")
        XCTAssertEqual(rule["installedRevision"] as? Int, 3)
        XCTAssertNil(try jsonObject(ControllerResult(state: .unavailable, detail: "x"))["rule"])
    }

    func testRuleOutcomeWireValues() throws {
        let outcomes: [NetworkRuleOutcome] = [
            .applied, .reset, .renewed, .staleGeneration, .staleRevision, .ownedByAnotherSession, .notFound,
            .invalidLease, .invalidCommand, .capacityExceeded,
        ]
        XCTAssertEqual(outcomes.map(\.rawValue), [
            "applied", "reset", "renewed", "stale_generation", "stale_revision", "owned_by_another_session",
            "not_found", "invalid_lease", "invalid_command", "capacity_exceeded",
        ])
    }

    func testUnknownStateIsRejectedByDecoding() {
        let line = Data(#"{"detail":"x","state":"installed","version":2}"#.utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(ControllerResult.self, from: line))
    }

    // MARK: - Cross-language fixtures (test/fixtures/network-filter-controller)

    /// Exactly what the controller prints for each state, built with the production encoder.
    private func fixtureResults() throws -> [String: ControllerResult] {
        var results = try [
            "installation-required": ControllerResult(
                state: .installationRequired,
                detail: "A signed containing app and provider provisioning profiles are required.", version: 3
            ),
            "approval-required": ControllerResult(
                state: .approvalRequired,
                detail: "Approve AutoMobile Network Identity Probe in System Settings, then run activate again.",
                version: 3
            ),
            "unavailable": ControllerResult(
                state: .unavailable,
                detail: "Operation timed out; installation may have completed. Run status to reconcile.", version: 3
            ),
            "ready": ControllerResult(
                state: .ready,
                detail: "Provider replied; per-app offline isolation is unverified until the signed run (#10263).",
                snapshot: snapshot(), version: 3
            ),
            "rule-applied": ControllerResult(
                state: .ready,
                detail: "Provider answered apply: applied.",
                rule: NetworkRuleResult(outcome: .applied, installedRevision: 3, leaseRemainingMilliseconds: 15000),
                version: 3
            ),
            "rule-owned-by-another-session": ControllerResult(
                state: .ready,
                detail: "Provider answered reset: owned_by_another_session.",
                rule: NetworkRuleResult(outcome: .ownedByAnotherSession), version: 3
            ),
        ]
        do {
            _ = try NetworkRuleArguments.parse(.apply, ["--delay-ms", "100"]) { $0 }
            XCTFail("version 3 must reject shaping")
        } catch {
            results["shaping-requires-contract-4"] = ControllerResult(state: .unavailable, detail: "\(error)",
                                                                      version: 3)
        }
        return results
    }

    private func versionFourFixtureResults() throws -> [String: ControllerResult] {
        let resolution = try ShapingProfile.resolve(ShapingRequest(
            delayMilliseconds: 100, downloadKilobitsPerSecond: 80,
            uploadKilobitsPerSecond: 40, packetLossPercent: 1.5
        )).get()
        let offline = try XCTUnwrap(snapshot().rules?.first)
        let shapedTarget = try XCTUnwrap(NetworkRuleTarget(
            simulator: offline.target.simulator,
            bundleId: "dev.jasonpearson.automobile.shaped"
        ))
        let shaped = NetworkRuleStatus(
            target: shapedTarget,
            owner: offline.owner,
            ownerGeneration: offline.ownerGeneration,
            revision: 4,
            condition: .shaped(resolution.profile),
            leaseRemainingMilliseconds: 14000,
            droppedFlows: 0,
            shaping: resolution
        )
        let probe = IdentityProbe(resolver: FakeIdentityResolver(), processTable: FakeProcessTable())
        let clock = FakeMonotonicClock()
        let coordinator = FlowShapingCoordinator(
            shaper: FlowShaper(clock: clock, ruleSource: FakeShapingRuleSource()),
            clock: clock, scheduler: FakePauseScheduler()
        )
        let mixed = probe.snapshot(
            managedSimulators: [offline.target.simulator], rules: [offline, shaped], version: 4,
            shapingActivity: coordinator.status()
        )
        var results: [String: ControllerResult] = [:]
        for (name, result) in try fixtureResults() where name != "shaping-requires-contract-4" {
            results[name] = ControllerResult(
                state: result.state,
                detail: result.detail,
                snapshot: name == "ready" ? mixed : nil,
                rule: result.rule,
                version: 4
            )
        }
        for (name, result) in [
            ("rule-applied-shaped", NetworkRuleResult(outcome: .applied, installedRevision: 4,
                                                      leaseRemainingMilliseconds: 15000, shaping: resolution)),
            ("rule-unsupported-condition", NetworkRuleResult(outcome: .unsupportedCondition)),
            ("rule-invalid-shaping", NetworkRuleResult(outcome: .invalidShaping,
                                                       rejection: NetworkShapingRejection(.outOfRange(.latency)))),
        ] {
            results[name] = ControllerResult(
                state: .ready,
                detail: "Provider answered apply: \(result.outcome.rawValue).",
                rule: result,
                version: 4
            )
        }
        do {
            _ = try ControllerInvocation.parse(["status", "--contract-version", "9"])
            XCTFail("unsupported version must fail")
        } catch let error as ControllerInvocationError {
            results["unsupported-contract-version"] = error.result
        }
        return results
    }

    func testVersionFourReadyRoundTripsWithShapingResolution() throws {
        let ready = try XCTUnwrap(versionFourFixtureResults()["ready"])
        let data = try ready.encodedLine()
        let decoded = try JSONDecoder().decode(ControllerResult.self, from: data)
        XCTAssertEqual(decoded.version, 4)
        XCTAssertEqual(decoded.snapshot?.version, 4)
        XCTAssertEqual(decoded.snapshot?.mode, "app_mixed")
        XCTAssertEqual(decoded.snapshot?.shapingActivity?.pendingPauses, 0)
        XCTAssertEqual(decoded.snapshot?.shapingActivity?.orphanedPauses, 0)
        XCTAssertEqual(decoded.snapshot?.shapingActivity?.untrackedDataCallbacks, 0)
        XCTAssertEqual(decoded.snapshot?.rules?.last?.shaping?.unapplied, [.packetLoss])
        XCTAssertEqual(try decoded.encodedLine(), data)
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
        let fixtures = try fixtureResults().merging(
            Dictionary(uniqueKeysWithValues: versionFourFixtureResults().map { ("v4/" + $0.key, $0.value) })
        ) { _, newest in newest }
        for (name, result) in fixtures {
            var line = try result.encodedLine()
            line.append(10)
            if let outputDirectory {
                let path = URL(fileURLWithPath: outputDirectory).appendingPathComponent("\(name).json")
                try FileManager.default.createDirectory(
                    at: path.deletingLastPathComponent(),
                    withIntermediateDirectories: true
                )
                try line.write(to: path)
            }
            let committed = try Data(contentsOf: fixtureDirectory.appendingPathComponent("\(name).json"))
            XCTAssertEqual(committed, line, "\(name).json drifted from ControllerResult encoding")
        }
    }
}
