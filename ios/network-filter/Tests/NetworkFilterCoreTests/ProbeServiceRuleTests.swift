import Foundation
@testable import NetworkFilterCore
import XCTest

final class ProbeServiceRuleTests: XCTestCase {
    private var clock = FakeMonotonicClock()
    private var store = NetworkRuleStore(clock: FakeMonotonicClock())
    private var service = ProbeService(
        probe: IdentityProbe(resolver: FakeIdentityResolver(), processTable: FakeProcessTable()),
        rules: NetworkRuleStore(clock: FakeMonotonicClock())
    )

    override func setUp() {
        super.setUp()
        clock = FakeMonotonicClock()
        store = NetworkRuleStore(clock: clock)
        service = ProbeService(
            probe: IdentityProbe(resolver: FakeIdentityResolver(), processTable: FakeProcessTable()),
            rules: store
        )
    }

    private func start() {
        XCTAssertTrue(service.finishStartup(generation: service.stopOrBeginStartup(), succeeded: true))
    }

    private func send(_ command: NetworkRuleCommand, version: Int = IdentityProbe.version) throws
        -> (NetworkRuleResult?, String?)
    {
        var reply: (Data?, String?)?
        try service.rule(version: version, command: JSONEncoder().encode(command)) { reply = ($0, $1) }
        let (data, error) = try XCTUnwrap(reply)
        return try (data.map { try JSONDecoder().decode(NetworkRuleResult.self, from: $0) }, error)
    }

    private func snapshot() throws -> ProbeSnapshot {
        var response: Data?
        service.snapshot(version: IdentityProbe.version, managedSimulators: Data("[]".utf8)) { data, _ in
            response = data
        }
        return try JSONDecoder().decode(ProbeSnapshot.self, from: XCTUnwrap(response))
    }

    func testInactiveProviderAppliesNothingAndAnswersWithTheTransientStartupState() throws {
        let (result, error) = try send(RuleFixtures.apply(RuleFixtures.ownership(revision: 1)))
        XCTAssertNil(result)
        XCTAssertTrue(ProbeReadbackStartupState.isTransient(error))
        XCTAssertTrue(store.activeRules().isEmpty)
    }

    func testApplyIsReportedInTheSnapshot() throws {
        start()
        let (result, error) = try send(RuleFixtures.apply(RuleFixtures.ownership(revision: 1)))
        XCTAssertNil(error)
        XCTAssertEqual(result?.outcome, .applied)
        let current = try snapshot()
        XCTAssertEqual(current.mode, IdentityProbe.appOfflineMode)
        XCTAssertEqual(current.rules?.map(\.revision), [1])
        XCTAssertEqual(current.rules?.first?.target, RuleFixtures.target)
        _ = try send(RuleFixtures.reset(RuleFixtures.ownership(revision: 2)))
        XCTAssertEqual(try snapshot().mode, IdentityProbe.allowOnlyMode)
    }

    func testRestartEndsEveryRule() throws {
        start()
        _ = try send(RuleFixtures.apply(RuleFixtures.ownership(revision: 1)))
        start()
        XCTAssertEqual(try snapshot().rules, [])
        let (renewed, _) = try send(RuleFixtures.renew(RuleFixtures.ownership(revision: 1)))
        XCTAssertEqual(renewed?.outcome, .notFound)
    }

    func testRejectsUnknownVersionAndMalformedCommands() throws {
        start()
        let (versioned, versionError) = try send(RuleFixtures.apply(RuleFixtures.ownership(revision: 1)), version: 99)
        XCTAssertNil(versioned)
        XCTAssertEqual(versionError, "Unsupported identity-probe protocol version")
        var reply: String?
        service.rule(version: IdentityProbe.version, command: Data("{}".utf8)) { _, error in reply = error }
        XCTAssertEqual(reply, "Invalid network rule command")
        XCTAssertTrue(store.activeRules().isEmpty)
    }
}

final class NetworkRuleArgumentsTests: XCTestCase {
    private let base = [
        "--managed", "/private/sets", "dfbf2d27-6674-42ea-afc4-ab702275d1d4",
        "--bundle-id", "dev.example.app",
        "--owner", "session-a",
        "--owner-generation", "1759900000000",
        "--revision", "3",
    ]

    private func parse(_ kind: NetworkRuleCommandKind, _ arguments: [String]) throws -> NetworkRuleCommand {
        try NetworkRuleArguments.parse(kind, arguments) { $0 == "/private/sets" ? "/private/sets" : "/resolved" + $0 }
    }

    func testParsesApply() throws {
        let command = try parse(.apply, base + ["--lease-ms", "15000"])
        XCTAssertEqual(command.kind, .apply)
        XCTAssertEqual(command.condition, .offline)
        XCTAssertEqual(command.leaseMilliseconds, 15000)
        XCTAssertEqual(command.target.simulator.udid, "DFBF2D27-6674-42EA-AFC4-AB702275D1D4")
        XCTAssertEqual(command.target.bundleId, "dev.example.app")
        XCTAssertEqual(command.ownership.ownerGeneration, 1_759_900_000_000)
        XCTAssertEqual(command.ownership.revision, 3)
    }

    func testResetTakesNoLeaseAndRenewNeedsOne() throws {
        let reset = try parse(.reset, base)
        XCTAssertNil(reset.leaseMilliseconds)
        XCTAssertNil(reset.condition)
        XCTAssertThrowsError(try parse(.reset, base + ["--lease-ms", "1"])) { error in
            XCTAssertEqual(error as? NetworkRuleArgumentError, .unexpectedArgument("--lease-ms"))
        }
        XCTAssertThrowsError(try parse(.renew, base)) { error in
            XCTAssertEqual(error as? NetworkRuleArgumentError, .missingFlag("--lease-ms"))
        }
    }

    func testRejectsMalformedArguments() {
        let cases: [([String], NetworkRuleArgumentError)] = [
            (Array(base.dropFirst(3)), .needsOneSimulator),
            (base + ["--managed", "/b", "DFBF2D27-6674-42EA-AFC4-AB702275D1D4"], .needsOneSimulator),
            (base + ["--revision", "4"], .unexpectedArgument("--revision")),
            (base.map { $0 == "3" ? "-3" : $0 }, .invalidValue(flag: "--revision", value: "-3")),
            (base.map { $0 == "dev.example.app" ? "dev example" : $0 }, .invalidValue(
                flag: "--bundle-id",
                value: "dev example"
            )),
            (base.map { $0 == "3" ? "0" : $0 }, .invalidValue(flag: "--owner", value: "session-a")),
            (base + ["--owner"], .unexpectedArgument("--owner")),
            (["--bundle-id"], .missingValue("--bundle-id")),
        ]
        for (arguments, expected) in cases {
            XCTAssertThrowsError(try parse(.reset, arguments)) { error in
                XCTAssertEqual(error as? NetworkRuleArgumentError, expected, "\(arguments)")
            }
        }
    }
}
