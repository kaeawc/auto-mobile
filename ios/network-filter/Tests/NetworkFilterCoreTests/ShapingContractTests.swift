// swiftlint:disable force_unwrapping
import Foundation
@testable import NetworkFilterCore
import XCTest

final class ShapingContractTests: XCTestCase {
    private let base = [
        "--managed", "/fixture/Devices", "DFBF2D27-6674-42EA-AFC4-AB702275D1D4",
        "--bundle-id", "dev.example.app", "--owner", "session-a", "--owner-generation", "10",
        "--revision", "1", "--lease-ms", "15000",
    ]

    func testEveryShapingFlagCreatesARequestWithZeroDefaults() throws {
        for (flag, text, request) in [
            ("--delay-ms", "100", ShapingRequest(delayMilliseconds: 100)),
            ("--down-kbps", "80", ShapingRequest(downloadKilobitsPerSecond: 80)),
            ("--up-kbps", "40", ShapingRequest(uploadKilobitsPerSecond: 40)),
            ("--packet-loss-percent", "1.5", ShapingRequest(packetLossPercent: 1.5)),
        ] {
            let command = try NetworkRuleArguments.parse(.apply, base + [flag, text], version: 4) { $0 }
            XCTAssertEqual(command.condition, .shaped(request))
            XCTAssertEqual(
                try JSONDecoder().decode(NetworkRuleCommand.self, from: JSONEncoder().encode(command)),
                command
            )
            XCTAssertThrowsError(try NetworkRuleArguments.parse(.apply, base + [flag, text]) { $0 }) { error in
                XCTAssertEqual(error as? NetworkRuleArgumentError, .shapingNeedsVersionFour)
            }
            for kind in [NetworkRuleCommandKind.reset, .renew] {
                XCTAssertThrowsError(try NetworkRuleArguments.parse(kind, [flag, text], version: 4) { $0 })
            }
            for suffix in [[flag], [flag, "not-a-number"], [flag, text, flag, text]] {
                XCTAssertThrowsError(try NetworkRuleArguments.parse(.apply, base + suffix, version: 4) { $0 })
            }
        }
        XCTAssertEqual(try NetworkRuleArguments.parse(.apply, base, version: 4) { $0 }.condition, .offline)
    }

    func testParserDoesNotResolveOrValidateRanges() throws {
        let command = try NetworkRuleArguments.parse(.apply, base + [
            "--delay-ms", "4001", "--down-kbps", "7", "--up-kbps", "1000001", "--packet-loss-percent", "101",
        ], version: 4) { $0 }
        XCTAssertEqual(command.condition, .shaped(ShapingRequest(
            delayMilliseconds: 4001, downloadKilobitsPerSecond: 7, uploadKilobitsPerSecond: 1_000_001,
            packetLossPercent: 101
        )))
        for loss in ["nan", "inf", "-inf"] {
            XCTAssertThrowsError(try NetworkRuleArguments.parse(
                .apply,
                base + ["--packet-loss-percent", loss],
                version: 4
            ) { $0 })
        }
    }

    func testShapedDecodingRequiresValidSiblingAndOfflineOmitsIt() throws {
        let command = RuleFixtures.apply(RuleFixtures.ownership(revision: 1))
        let encoded = try JSONEncoder().encode(command)
        XCTAssertFalse(try XCTUnwrap(String(data: encoded, encoding: .utf8)).contains("shaping"))
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        json["condition"] = "shaped"
        for shaping in [nil, [:], ["delayMilliseconds": "bad"]] as [[String: Any]?] {
            json["shaping"] = shaping
            XCTAssertThrowsError(try JSONDecoder().decode(
                NetworkRuleCommand.self,
                from: JSONSerialization.data(withJSONObject: json)
            ))
        }
        let store = NetworkRuleStore(clock: FakeMonotonicClock())
        _ = store.execute(command)
        let status = try XCTUnwrap(store.activeRules().first)
        let statusData = try JSONEncoder().encode(status)
        XCTAssertFalse(try XCTUnwrap(String(data: statusData, encoding: .utf8)).contains("shaping"))
        json = try XCTUnwrap(JSONSerialization.jsonObject(with: statusData) as? [String: Any])
        json["condition"] = "shaped"
        for shaping in [nil, [:], ["profile": ["outboundDelayMilliseconds": 5000]]] as [[String: Any]?] {
            json["shaping"] = shaping
            XCTAssertThrowsError(try JSONDecoder().decode(
                NetworkRuleStatus.self,
                from: JSONSerialization.data(withJSONObject: json)
            ))
        }
    }

    func testProbeSupportsBothVersionsAndProjectsModesAndRules() throws {
        let store = NetworkRuleStore(clock: FakeMonotonicClock(), supportsShaping: true)
        let probe = IdentityProbe(resolver: FakeIdentityResolver(), processTable: FakeProcessTable())
        let service = ProbeService(probe: probe, rules: store)
        XCTAssertTrue(service.finishStartup(generation: service.stopOrBeginStartup(), succeeded: true))
        XCTAssertEqual(IdentityProbe.version, 4)
        XCTAssertEqual(IdentityProbe.supportedVersions, [3, 4])
        let shaped = NetworkRuleCommand(
            kind: .apply,
            target: RuleFixtures.target,
            ownership: RuleFixtures.ownership(revision: 1),
            condition: .shaped(ShapingRequest(
                delayMilliseconds: 100,
                packetLossPercent: 1
            )),
            leaseMilliseconds: 15000
        )
        var result: NetworkRuleResult?
        var replyError: String?
        for version in [3, 4] {
            try service.rule(version: version, command: JSONEncoder().encode(shaped)) { data, error in
                replyError = error
                result = data.flatMap { try? JSONDecoder().decode(NetworkRuleResult.self, from: $0) }
            }
            XCTAssertNil(replyError)
            XCTAssertEqual(result?.outcome, version == 3 ? .invalidCommand : .applied)
            XCTAssertEqual(store.activeRules().count, version == 3 ? 0 : 1)
        }
        func snapshot(_ version: Int) throws -> ProbeSnapshot {
            var response: Data?
            service.snapshot(version: version, managedSimulators: Data("[]".utf8)) { data, error in
                response = data
                replyError = error
            }
            XCTAssertNil(replyError)
            return try JSONDecoder().decode(ProbeSnapshot.self, from: XCTUnwrap(response))
        }
        XCTAssertEqual(try snapshot(4).mode, "app_shaped")
        XCTAssertEqual(try snapshot(3).mode, "allow_only")
        let offlineTarget = NetworkRuleTarget(simulator: RuleFixtures.simulator, bundleId: "dev.example.offline")!
        try service.rule(version: 3, command: JSONEncoder().encode(RuleFixtures.apply(
            RuleFixtures.ownership(revision: 1), target: offlineTarget
        ))) { data, error in
            replyError = error
            result = data.flatMap { try? JSONDecoder().decode(NetworkRuleResult.self, from: $0) }
        }
        XCTAssertNil(replyError)
        XCTAssertEqual(result?.outcome, .applied)
        let mixed = try snapshot(4)
        XCTAssertEqual(mixed.mode, "app_mixed")
        XCTAssertEqual(mixed.version, 4)
        XCTAssertEqual(mixed.rules?.count, 2)
        XCTAssertTrue(
            mixed.limitations
                .contains(
                    "Shaped rules are enforced on NEW flows of the attributed app only; established flows are not shaped."
                )
        )
        let legacy = try snapshot(3)
        XCTAssertEqual(legacy.version, 3)
        XCTAssertEqual(legacy.mode, "app_offline")
        XCTAssertEqual(legacy.rules?.map(\.condition), [.offline])
        XCTAssertEqual(
            legacy.limitations.last,
            "Omitted 1 shaped rule(s): contract version 3 supports only offline rules."
        )
        _ = store.execute(RuleFixtures.reset(RuleFixtures.ownership(revision: 2)))
        XCTAssertEqual(try snapshot(4).mode, "app_offline")
        _ = store.execute(RuleFixtures.reset(RuleFixtures.ownership(revision: 2), target: offlineTarget))
        XCTAssertEqual(try snapshot(4).mode, "allow_only")
        for version in [0, 2, 5, 99] {
            service.snapshot(version: version, managedSimulators: Data("[]".utf8)) { data, error in
                XCTAssertNil(data)
                XCTAssertEqual(error, "Unsupported identity-probe protocol version")
            }
            try service.rule(version: version, command: JSONEncoder().encode(shaped)) { data, error in
                XCTAssertNil(data)
                XCTAssertEqual(error, "Unsupported identity-probe protocol version")
            }
        }
    }
}
