import Foundation
@testable import NetworkFilterCore
import XCTest

final class WatchFlowTests: XCTestCase {
    func testWatchPassesBothDirectionsThenOfflineDropsExistingFlow() throws {
        let clock = FakeMonotonicClock()
        let store = NetworkRuleStore(clock: clock)
        let shaper = FlowShaper(clock: clock, ruleSource: store)
        let watch = NetworkRuleCommand(
            kind: .apply, target: RuleFixtures.target, ownership: RuleFixtures.ownership(revision: 1),
            condition: .watch, leaseMilliseconds: 15000
        )
        XCTAssertEqual(store.execute(watch).outcome, .applied)
        let flow = UUID()
        XCTAssertEqual(
            shaper.newFlow(flow, target: RuleFixtures.target, transport: .stream),
            .filter(inbound: true, outbound: true, peekBytes: 65536)
        )
        for direction in [FlowDirection.inbound, .outbound] {
            XCTAssertEqual(
                shaper.data(flow, direction: direction, availableBytes: 42),
                .pass(bytes: 42, peekBytes: 65536)
            )
        }
        let offline = RuleFixtures.apply(RuleFixtures.ownership(revision: 2))
        XCTAssertEqual(store.execute(offline).outcome, .applied)
        XCTAssertEqual(store.existingFlows(for: offline), .unaffected)
        XCTAssertEqual(shaper.data(flow, direction: .outbound, availableBytes: 42), .drop)
        XCTAssertEqual(store.existingFlows(for: offline), .dropped)
        XCTAssertEqual(store.activeRules().first?.droppedFlows, 1)
        XCTAssertEqual(shaper.data(flow, direction: .inbound, availableBytes: 42), .allow)
        XCTAssertEqual(store.activeRules().first?.droppedFlows, 1)
        _ = store.execute(RuleFixtures.reset(RuleFixtures.ownership(revision: 3)))
        XCTAssertEqual(shaper.newFlow(UUID(), target: RuleFixtures.target, transport: .stream), .allow)
    }

    func testNewFlowDropsAndStaleTicketsCannotClaimExistingDrops() throws {
        let store = NetworkRuleStore(clock: FakeMonotonicClock())
        let command = RuleFixtures.apply(RuleFixtures.ownership(revision: 1))
        _ = store.execute(command)
        let ticket = try XCTUnwrap(store.currentTicket(for: RuleFixtures.target))
        XCTAssertTrue(store.commitDrop(ticket))
        XCTAssertEqual(store.existingFlows(for: command), .unaffected)
        _ = store.execute(RuleFixtures.reset(RuleFixtures.ownership(revision: 2)))
        XCTAssertFalse(store.commitOfflineDrop(for: RuleFixtures.target, existingFlow: true))
        XCTAssertEqual(store.existingFlows(for: command), .unaffected)
    }

    func testWatchExpiresAndUnwatchedTargetsKeepAllowFastPath() throws {
        let clock = FakeMonotonicClock()
        let store = NetworkRuleStore(clock: clock)
        let shaper = FlowShaper(clock: clock, ruleSource: store)
        _ = store.execute(NetworkRuleCommand(
            kind: .apply, target: RuleFixtures.target, ownership: RuleFixtures.ownership(revision: 1),
            condition: .watch, leaseMilliseconds: 1000
        ))
        let sibling = try XCTUnwrap(NetworkRuleTarget(simulator: RuleFixtures.sibling, bundleId: RuleFixtures.bundleId))
        let other = try XCTUnwrap(NetworkRuleTarget(simulator: RuleFixtures.simulator, bundleId: "other.app"))
        for target in [sibling, other] {
            XCTAssertEqual(shaper.newFlow(UUID(), target: target, transport: .stream), .allow)
        }
        let flow = UUID()
        _ = shaper.newFlow(flow, target: RuleFixtures.target, transport: .stream)
        clock.advance(milliseconds: 1001)
        XCTAssertEqual(shaper.data(flow, direction: .inbound, availableBytes: 1), .allow)
        XCTAssertNil(store.evaluationSnapshot())
    }

    func testServiceReadbackCountsCommittedDataDropsAndPreservesLegacyOutput() throws {
        let clock = FakeMonotonicClock()
        let store = NetworkRuleStore(clock: clock)
        let shaper = FlowShaper(clock: clock, ruleSource: store)
        let service = ProbeService(
            probe: IdentityProbe(resolver: FakeIdentityResolver(), processTable: FakeProcessTable()), rules: store
        )
        XCTAssertTrue(service.finishStartup(generation: service.stopOrBeginStartup(), succeeded: true))
        func send(_ command: NetworkRuleCommand, version: Int) throws -> NetworkRuleResult {
            var response: Data?
            try service.rule(version: version, command: JSONEncoder().encode(command)) { data, error in
                XCTAssertNil(error)
                response = data
            }
            return try JSONDecoder().decode(NetworkRuleResult.self, from: XCTUnwrap(response))
        }
        let watch = NetworkRuleCommand(
            kind: .apply, target: RuleFixtures.target, ownership: RuleFixtures.ownership(revision: 1),
            condition: .watch, leaseMilliseconds: 15000
        )
        for version in [3, 4] {
            XCTAssertEqual(try send(watch, version: version).outcome, .invalidCommand)
            XCTAssertTrue(store.activeRules().isEmpty)
        }
        XCTAssertEqual(try send(watch, version: 5).outcome, .applied)
        let flow = UUID()
        _ = shaper.newFlow(flow, target: RuleFixtures.target, transport: .stream)
        let offline = RuleFixtures.apply(RuleFixtures.ownership(revision: 2))
        XCTAssertEqual(try send(offline, version: 5).existingFlows, .unaffected)
        XCTAssertEqual(shaper.data(flow, direction: .inbound, availableBytes: 1), .drop)
        XCTAssertEqual(try send(offline, version: 5).existingFlows, .dropped)
        for version in [3, 4] {
            let legacy = try send(offline, version: version)
            XCTAssertNil(legacy.existingFlows)
            let result = ControllerResult(state: .ready, detail: "ok", rule: NetworkRuleResult(
                outcome: .applied, existingFlows: .dropped
            ), version: version)
            let line = try XCTUnwrap(String(data: result.encodedLine(), encoding: .utf8))
            XCTAssertFalse(line.contains("existingFlows"))
            let probe = IdentityProbe(resolver: FakeIdentityResolver(), processTable: FakeProcessTable())
            let watchedStore = NetworkRuleStore(clock: clock)
            _ = watchedStore.execute(watch)
            XCTAssertEqual(
                probe.snapshot(managedSimulators: [], rules: watchedStore.activeRules(), version: version).rules,
                []
            )
        }
    }

    func testWatchArgumentRequiresVersionFiveAndRejectsMixedConditions() throws {
        let arguments = [
            "--managed", RuleFixtures.simulator.deviceSet, RuleFixtures.simulator.udid,
            "--bundle-id", RuleFixtures.bundleId, "--owner", "session-a", "--owner-generation", "10",
            "--revision", "1", "--lease-ms", "15000", "--watch-only", "true",
        ]
        for version in [3, 4] {
            XCTAssertThrowsError(try NetworkRuleArguments.parse(.apply, arguments, version: version) { $0 })
        }
        XCTAssertEqual(try NetworkRuleArguments.parse(.apply, arguments, version: 5) { $0 }.condition, .watch)
        XCTAssertThrowsError(try NetworkRuleArguments.parse(.apply, arguments + ["--delay-ms", "1"], version: 5) { $0 })
    }

    func testWatchCapacityFailsOpen() {
        let clock = FakeMonotonicClock()
        let store = NetworkRuleStore(clock: clock, supportsShaping: true)
        let shaper = FlowShaper(clock: clock, ruleSource: store)
        _ = store.execute(NetworkRuleCommand(
            kind: .apply, target: RuleFixtures.target, ownership: RuleFixtures.ownership(revision: 1),
            condition: .watch, leaseMilliseconds: 60000
        ))
        for _ in 0 ..< FlowShaper.maximumFlows {
            XCTAssertEqual(
                shaper.newFlow(UUID(), target: RuleFixtures.target, transport: .stream),
                .filter(inbound: true, outbound: true, peekBytes: 65536)
            )
        }
        XCTAssertEqual(shaper.newFlow(UUID(), target: RuleFixtures.target, transport: .stream), .allow)
    }

    func testPausedDataCommitsOneDropButPausedNewFlowDoesNotClaimAnExistingConnection() throws {
        for transport in [FlowTransport.stream, .datagram] {
            let clock = FakeMonotonicClock()
            let store = NetworkRuleStore(clock: clock, supportsShaping: true)
            let scheduler = FakePauseScheduler()
            let coordinator = FlowShapingCoordinator(
                shaper: FlowShaper(clock: clock, ruleSource: store), clock: clock, scheduler: scheduler
            )
            _ = store.execute(NetworkRuleCommand(
                kind: .apply, target: RuleFixtures.target, ownership: RuleFixtures.ownership(revision: 1),
                condition: .shaped(ShapingRequest(delayMilliseconds: 100)), leaseMilliseconds: 15000
            ))
            let flow = UUID()
            let resume = RecordingResume()
            let newFlow = coordinator.newFlow(
                flow,
                target: RuleFixtures.target,
                transport: transport,
                onResume: resume.receive
            )
            if transport == .datagram {
                XCTAssertEqual(newFlow, .filter(inbound: true, outbound: true, peekBytes: 65536))
                XCTAssertEqual(
                    coordinator.data(flow, direction: .outbound, availableBytes: 10, onResume: resume.receive),
                    .pause
                )
            } else {
                XCTAssertEqual(newFlow, .pause)
            }
            let offline = RuleFixtures.apply(RuleFixtures.ownership(revision: 2))
            _ = store.execute(offline)
            coordinator.rulesChanged()
            XCTAssertEqual(store.existingFlows(for: offline), transport == .datagram ? .dropped : .unaffected)
            clock.advance(milliseconds: 10)
            scheduler.runDue(clock)
            XCTAssertEqual(resume.verdicts, [.drop])
            coordinator.rulesChanged()
            scheduler.runDue(clock)
            XCTAssertEqual(resume.verdicts, [.drop])
            XCTAssertEqual(store.activeRules().first?.droppedFlows, 1)
        }
    }
}
