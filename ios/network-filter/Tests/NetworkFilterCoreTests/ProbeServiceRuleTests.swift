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

extension ProbeServiceRuleTests {
    func testRuleHooksRunOutsideLocksAndStopClearsRules() throws {
        var changes = 0
        var stops = 0
        service = ProbeService(
            probe: IdentityProbe(resolver: FakeIdentityResolver(), processTable: FakeProcessTable()), rules: store,
            onRulesChanged: { [self] in
                changes += 1
                // Reenter the service lock and store: hooks must hold neither.
                _ = try? snapshot()
                _ = store.activeRules()
            }, onStop: { [self] in
                stops += 1
                XCTAssertEqual(store.activeRules(), [])
                // Stop holds the service lock; it may read the store but must
                // not reenter the service. Rule/activity hooks remain outside.
            }
        )
        _ = try send(RuleFixtures.apply(RuleFixtures.ownership(revision: 1)))
        XCTAssertEqual(changes, 0)
        start()
        XCTAssertEqual(stops, 1)
        _ = try send(RuleFixtures.apply(RuleFixtures.ownership(revision: 1)), version: 99)
        XCTAssertEqual(changes, 0)
        let shaped = NetworkRuleCommand(
            kind: .apply, target: RuleFixtures.target, ownership: RuleFixtures.ownership(revision: 1),
            condition: .shaped(ShapingRequest(delayMilliseconds: 100)), leaseMilliseconds: 15000
        )
        _ = try send(shaped, version: 3)
        XCTAssertEqual(changes, 0)
        _ = try send(RuleFixtures.apply(RuleFixtures.ownership(revision: 1)))
        _ = try send(RuleFixtures.renew(RuleFixtures.ownership(revision: 1)))
        _ = try send(RuleFixtures.reset(RuleFixtures.ownership(revision: 2)))
        // Executed refusals are commands too.
        _ = try send(RuleFixtures.renew(RuleFixtures.ownership(revision: 1)))
        XCTAssertEqual(changes, 4)
        _ = service.stopOrBeginStartup()
        XCTAssertEqual(stops, 2)
        // The old pin is kept outside the hook, which now holds the lock.
        service.snapshot(version: 4, managedSimulators: Data("[]".utf8)) { data, error in
            XCTAssertNil(data)
            XCTAssertEqual(error, ProbeReadbackStartupState.inactiveProviderMessage)
        }
    }

    func testStopHookCannotInterleaveWithRestartAndRuleCommand() throws {
        let entered = DispatchSemaphore(value: 0)
        let finished = DispatchGroup()
        let events = RecordingResume()
        let command = try JSONEncoder().encode(NetworkRuleCommand(
            kind: .apply, target: RuleFixtures.target, ownership: RuleFixtures.ownership(revision: 2),
            condition: .shaped(ShapingRequest(delayMilliseconds: 100)), leaseMilliseconds: 15000
        ))
        store = NetworkRuleStore(clock: clock, supportsShaping: true)
        XCTAssertEqual(store.execute(RuleFixtures.apply(RuleFixtures.ownership(revision: 1))).outcome, .applied)
        service = ProbeService(
            probe: IdentityProbe(resolver: FakeIdentityResolver(), processTable: FakeProcessTable()), rules: store,
            onStop: { [self] in
                XCTAssertEqual(store.activeRules(), []) // removeAll precedes onStop.
                // Pin the gate before launching the competitor, so its own
                // lock acquisition cannot mask an unlocked stop hook.
                let available = service.lock.try()
                if available { service.lock.unlock() }
                XCTAssertFalse(available, "Stop must hold the same lock as rule and finishStartup")
                finished.enter()
                let current = service
                DispatchQueue.global().async {
                    entered.signal()
                    // Model a restart that would otherwise install a new rule
                    // while the previous run's stop hook was still settling.
                    XCTAssertTrue(current.finishStartup(generation: 1, succeeded: true))
                    current.rule(version: 4, command: command) { data, error in
                        XCTAssertNil(error)
                        XCTAssertNotNil(data)
                        events.receive(.filter(inbound: true, outbound: true, peekBytes: 1))
                    }
                    finished.leave()
                }
                entered.wait()
                events.receive(.allow) // All old pauses settled by this hook.
            }
        )
        XCTAssertEqual(service.stopOrBeginStartup(), 1)
        finished.wait()
        XCTAssertEqual(events.verdicts, [.allow, .filter(inbound: true, outbound: true, peekBytes: 1)])
        XCTAssertEqual(store.activeRules().count, 1)
    }

    func testShapingActivityVersionFourOnlyAndShapedApplyAcknowledged() throws {
        store = NetworkRuleStore(clock: clock, supportsShaping: true)
        let coordinator = FlowShapingCoordinator(
            shaper: FlowShaper(clock: clock, ruleSource: store), clock: clock, scheduler: FakePauseScheduler()
        )
        var activityCalls = 0
        service = ProbeService(
            probe: IdentityProbe(resolver: FakeIdentityResolver(), processTable: FakeProcessTable()), rules: store,
            shapingActivity: { [self] in
                activityCalls += 1
                // Version 3 does not call shapingActivity again, so this pins
                // service reentry without recursion or a real timer.
                service.snapshot(version: 3, managedSimulators: Data("[]".utf8)) { data, error in
                    XCTAssertNotNil(data)
                    XCTAssertNil(error)
                }
                return coordinator.status()
            }
        )
        start()
        let command = NetworkRuleCommand(
            kind: .apply, target: RuleFixtures.target, ownership: RuleFixtures.ownership(revision: 1),
            condition: .shaped(ShapingRequest(delayMilliseconds: 100)), leaseMilliseconds: 15000
        )
        XCTAssertEqual(try send(command).0?.outcome, .applied)
        for version in [3, 4] {
            var data: Data?
            service.snapshot(version: version, managedSimulators: Data("[]".utf8)) { data = $0; XCTAssertNil($1) }
            let snapshot = try JSONDecoder().decode(ProbeSnapshot.self, from: XCTUnwrap(data))
            let object = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(data)) as? [String: Any])
            if version == 3 {
                XCTAssertNil(snapshot.shapingActivity)
                XCTAssertNil(object["shapingActivity"])
                XCTAssertEqual(activityCalls, 0)
            } else {
                XCTAssertEqual(snapshot.shapingActivity, coordinator.status())
                XCTAssertNotNil(object["shapingActivity"])
                XCTAssertEqual(activityCalls, 1)
            }
        }
    }
}
