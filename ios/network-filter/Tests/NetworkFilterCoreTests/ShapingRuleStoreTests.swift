// swiftlint:disable force_unwrapping
import Foundation
@testable import NetworkFilterCore
import XCTest

final class ShapingRuleStoreTests: XCTestCase {
    private var clock = FakeMonotonicClock()
    private var store = NetworkRuleStore(clock: FakeMonotonicClock(), supportsShaping: true)
    private let request = ShapingRequest(
        delayMilliseconds: 100, downloadKilobitsPerSecond: 80, uploadKilobitsPerSecond: 40, packetLossPercent: 1.5
    )

    override func setUp() {
        super.setUp()
        clock = FakeMonotonicClock()
        store = NetworkRuleStore(clock: clock, supportsShaping: true)
    }

    private func apply(
        _ request: ShapingRequest? = nil,
        revision: UInt64 = 1,
        generation: UInt64 = 10,
        owner: String = "session-a",
        target: NetworkRuleTarget = RuleFixtures.target,
        lease: UInt64 = 15000
    )
        -> NetworkRuleCommand
    {
        NetworkRuleCommand(
            kind: .apply,
            target: target,
            ownership: RuleFixtures.ownership(owner, generation: generation, revision: revision),
            condition: .shaped(request ?? self.request),
            leaseMilliseconds: lease
        )
    }

    func testProviderDefaultRejectsBeforeLeaseFencingAndExpiryWithoutMutation() {
        store = NetworkRuleStore(clock: clock)
        XCTAssertEqual(
            store.execute(apply(ShapingRequest(delayMilliseconds: 5000), lease: 0)).outcome,
            .unsupportedCondition
        )
        XCTAssertEqual(store.execute(RuleFixtures.apply(RuleFixtures.ownership(revision: 1))).outcome, .applied)
        let ticket = store.currentTicket(for: RuleFixtures.target)!
        clock.advance(milliseconds: 1000)
        let before = store.activeRules()
        XCTAssertEqual(store.execute(apply(revision: 2, owner: "other")).outcome, .unsupportedCondition)
        XCTAssertEqual(store.activeRules(), before)
        XCTAssertTrue(store.commitDrop(ticket))
        XCTAssertNil(store.shapingRule(for: RuleFixtures.target))
        // An unsupported request must not sweep an expired rule into a tombstone.
        clock.advance(milliseconds: 15000)
        XCTAssertEqual(store.execute(apply()).outcome, .unsupportedCondition)
        // Normal commands still sweep and fence expiry.
        XCTAssertEqual(store.execute(RuleFixtures.apply(RuleFixtures.ownership(revision: 1))).outcome, .staleRevision)
    }

    func testAppliedResolutionAndIdenticalRedeliveryRefreshLease() throws {
        let resolution = try ShapingProfile.resolve(request).get()
        let result = store.execute(apply())
        XCTAssertEqual(result, NetworkRuleResult(
            outcome: .applied,
            installedRevision: 1,
            leaseRemainingMilliseconds: 15000,
            shaping: resolution
        ))
        XCTAssertEqual(result.shaping?.applied, [.latency, .downloadBandwidth, .uploadBandwidth])
        XCTAssertEqual(result.shaping?.unapplied, [.packetLoss])
        XCTAssertEqual(store.activeRules().first?.condition, .shaped(resolution.profile))
        clock.advance(milliseconds: 1000)
        XCTAssertEqual(store.execute(apply()), result)
        XCTAssertEqual(store.activeRules().first?.leaseRemainingMilliseconds, 15000)
        XCTAssertEqual(store.activeRules().first?.droppedFlows, 0)
    }

    func testInvalidShapingChangesNothingAndLeavesNoTombstone() {
        let cases: [(ShapingRequest, ShapingRejection)] = [
            (ShapingRequest(delayMilliseconds: 4001), .outOfRange(.latency)),
            (ShapingRequest(downloadKilobitsPerSecond: 7), .outOfRange(.downloadBandwidth)),
            (ShapingRequest(uploadKilobitsPerSecond: 1_000_001), .outOfRange(.uploadBandwidth)),
            (ShapingRequest(packetLossPercent: 101), .outOfRange(.packetLoss)),
            (ShapingRequest(packetLossPercent: 2), .nothingToApply(unapplied: [.packetLoss])),
            (ShapingRequest(), .nothingToApply(unapplied: [])),
        ]
        for (request, rejection) in cases {
            let empty = NetworkRuleStore(clock: clock, supportsShaping: true)
            XCTAssertEqual(empty.execute(apply(request)), NetworkRuleResult(
                outcome: .invalidShaping, rejection: NetworkShapingRejection(rejection)
            ))
            XCTAssertEqual(empty.execute(RuleFixtures.apply(RuleFixtures.ownership(revision: 1))).outcome, .applied)
            _ = store.execute(apply())
            let before = store.activeRules()
            XCTAssertEqual(store.execute(apply(request, revision: 2)).outcome, .invalidShaping)
            XCTAssertEqual(store.activeRules(), before)
        }
    }

    func testOneRevisionNamesOneConfigurationAndNewerRevisionsMayReplaceEitherKind() {
        _ = store.execute(apply())
        clock.advance(milliseconds: 1000)
        let before = store.activeRules()
        XCTAssertEqual(store.execute(apply(ShapingRequest(delayMilliseconds: 101))).outcome, .invalidCommand)
        // Same resolved profile but different packet loss is still a different request.
        XCTAssertEqual(store.execute(apply(ShapingRequest(
            delayMilliseconds: 100, downloadKilobitsPerSecond: 80, uploadKilobitsPerSecond: 40
        ))).outcome, .invalidCommand)
        XCTAssertEqual(store.execute(RuleFixtures.apply(RuleFixtures.ownership(revision: 1))).outcome, .invalidCommand)
        XCTAssertEqual(store.activeRules(), before)
        let first = store.shapingRule(for: RuleFixtures.target)!
        XCTAssertEqual(store.execute(apply(revision: 2)).outcome, .applied)
        XCTAssertNotEqual(store.shapingRule(for: RuleFixtures.target)?.ticket, first.ticket)
        XCTAssertEqual(store.execute(RuleFixtures.apply(RuleFixtures.ownership(revision: 3))).outcome, .applied)
        XCTAssertNil(store.shapingRule(for: RuleFixtures.target))
        XCTAssertNotNil(store.evaluationSnapshot())
        XCTAssertEqual(store.execute(apply(revision: 3)).outcome, .invalidCommand)
        XCTAssertEqual(store.execute(apply(revision: 4)).outcome, .applied)
        XCTAssertEqual(store.evaluationSnapshot()?.shapedTargets, [RuleFixtures.target])
    }

    func testShapedOwnershipFencingRenewResetAndRemoveAll() {
        XCTAssertEqual(store.execute(apply(revision: 2)).outcome, .applied)
        let before = store.activeRules()
        for (command, outcome) in [
            (apply(revision: 1), NetworkRuleOutcome.staleRevision),
            (apply(revision: 3, generation: 9), .staleGeneration),
            (apply(owner: "other"), .ownedByAnotherSession),
            (RuleFixtures.reset(RuleFixtures.ownership("other", revision: 3)), .ownedByAnotherSession),
            (RuleFixtures.renew(RuleFixtures.ownership("other", revision: 2)), .notFound),
            (RuleFixtures.reset(RuleFixtures.ownership(revision: 2)), .staleRevision),
            (RuleFixtures.renew(RuleFixtures.ownership(revision: 1)), .staleRevision),
            (RuleFixtures.renew(RuleFixtures.ownership(generation: 9, revision: 2)), .staleGeneration),
        ] {
            XCTAssertEqual(store.execute(command).outcome, outcome)
            XCTAssertEqual(store.activeRules(), before)
        }
        clock.advance(milliseconds: 1000)
        XCTAssertEqual(store.execute(RuleFixtures.renew(RuleFixtures.ownership(revision: 2))).outcome, .renewed)
        XCTAssertEqual(store.activeRules().first?.leaseRemainingMilliseconds, 15000)
        let reset = RuleFixtures.reset(RuleFixtures.ownership(generation: 11, revision: 1))
        XCTAssertEqual(store.execute(reset).outcome, .reset)
        XCTAssertEqual(store.execute(reset).outcome, .reset)
        XCTAssertNil(store.shapingRule(for: RuleFixtures.target))
        XCTAssertEqual(store.execute(apply(revision: 99)).outcome, .staleGeneration)
        XCTAssertEqual(store.execute(apply(revision: 1, generation: 11)).outcome, .staleRevision)
        XCTAssertEqual(store.execute(apply(revision: 2, generation: 11)).outcome, .applied)
        store.removeAll()
        XCTAssertNil(store.shapingRule(for: RuleFixtures.target))
        XCTAssertEqual(store.execute(apply(revision: 2, generation: 11)).outcome, .staleRevision)
        XCTAssertEqual(
            store.execute(RuleFixtures.renew(RuleFixtures.ownership(generation: 11, revision: 2))).outcome,
            .notFound
        )
    }

    func testExpiryAndCapacityApplyToShapedRules() {
        _ = store.execute(apply(lease: 1000))
        clock.advance(milliseconds: 999)
        XCTAssertNotNil(store.shapingRule(for: RuleFixtures.target))
        clock.advance(milliseconds: 1)
        XCTAssertNil(store.shapingRule(for: RuleFixtures.target))
        XCTAssertEqual(store.execute(apply()).outcome, .staleRevision)
        XCTAssertEqual(store.execute(apply(owner: "other")).outcome, .applied)
        for index in 1 ..< NetworkRuleStore.maximumRules {
            let target = NetworkRuleTarget(simulator: RuleFixtures.simulator, bundleId: "dev.example.app\(index)")!
            XCTAssertEqual(store.execute(apply(target: target)).outcome, .applied)
        }
        let overflow = NetworkRuleTarget(simulator: RuleFixtures.simulator, bundleId: "dev.example.overflow")!
        XCTAssertEqual(store.execute(apply(target: overflow)).outcome, .capacityExceeded)
    }

    func testShapedRuleCannotCommitADropAndPolicyAttributes() {
        _ = store.execute(RuleFixtures.apply(RuleFixtures.ownership(revision: 1)))
        let old = store.currentTicket(for: RuleFixtures.target)!
        _ = store.execute(apply(revision: 2))
        XCTAssertFalse(store.commitDrop(old))
        XCTAssertFalse(store.commitDrop(store.shapingRule(for: RuleFixtures.target)!.ticket))
        XCTAssertEqual(store.evaluationSnapshot()?.shapedTargets, [RuleFixtures.target])
        let table = FakeProcessTable()
        let identities = FakeIdentityResolver()
        identities.identifiers[501] = RuleFixtures.bundleId
        let token = table.add(pid: 501, parent: 400, path: CapturedSimulator.appExecutable())
        let policy = AppFlowPolicy(store: store, processTable: table, identityResolver: identities)
        XCTAssertEqual(
            policy.verdict(sourceAppAuditToken: nil, sourceProcessAuditToken: token),
            .shape(RuleFixtures.target)
        )
        XCTAssertGreaterThan(table.tokenLookups, 0)
        XCTAssertEqual(identities.lookups, 1)
        XCTAssertEqual(store.activeRules().first?.droppedFlows, 0)
    }

    func testStoreFeedsShaperAndResetOrExpiryReleasesPendingFlow() {
        let shaper = FlowShaper(clock: clock, ruleSource: store)
        for expires in [false, true] {
            let revision: UInt64 = expires ? 3 : 1
            XCTAssertEqual(store.execute(apply(revision: revision, lease: 1000)).outcome, .applied)
            let flow = UUID(uuidString: "00000000-0000-0000-0000-000000000001")!
            guard case let .pause(pause) = shaper.newFlow(flow, target: RuleFixtures.target, transport: .stream) else {
                return XCTFail("shaped stream admitted with latency hold")
            }
            if expires { clock.advance(milliseconds: 1000) }
            else {
                XCTAssertEqual(store.execute(RuleFixtures.reset(RuleFixtures.ownership(revision: 2))).outcome, .reset)
            }
            if expires {
                XCTAssertEqual(shaper.resume(pause), .settled(.allow))
                XCTAssertTrue(shaper.settleStale().isEmpty)
            } else {
                XCTAssertEqual(shaper.settleStale(), [FlowSettlement(pause: pause, decision: .allow)])
                XCTAssertEqual(shaper.resume(pause), .alreadySettled)
            }
            XCTAssertNil(store.shapingRule(for: RuleFixtures.target))
            XCTAssertEqual(
                shaper
                    .newFlow(
                        UUID(uuidString: "00000000-0000-0000-0000-000000000002")!,
                        target: RuleFixtures.target,
                        transport: .stream
                    ),
                .allow
            )
        }
    }
}

extension ShapingRuleStoreTests {
    func testEvaluationSnapshotCombinesOfflineAndShapedSimulators() {
        let offline = RuleFixtures.apply(RuleFixtures.ownership(revision: 1))
        let shapedTarget = NetworkRuleTarget(simulator: RuleFixtures.sibling, bundleId: RuleFixtures.bundleId)!
        XCTAssertEqual(store.execute(offline).outcome, .applied)
        XCTAssertEqual(store.execute(apply(target: shapedTarget)).outcome, .applied)
        XCTAssertEqual(store.evaluationSnapshot().map { Set($0.tickets.keys) }, [RuleFixtures.target])
        XCTAssertEqual(store.evaluationSnapshot()?.shapedTargets, [shapedTarget])
        XCTAssertEqual(store.evaluationSnapshot()?.managedSimulators, [RuleFixtures.simulator, RuleFixtures.sibling])
        _ = store.execute(RuleFixtures.reset(RuleFixtures.ownership(revision: 2)))
        XCTAssertEqual(store.evaluationSnapshot()?.tickets.count, 0)
        XCTAssertEqual(store.evaluationSnapshot()?.managedSimulators, [RuleFixtures.sibling])
        XCTAssertEqual(store.execute(RuleFixtures.reset(
            RuleFixtures.ownership(revision: 2), target: shapedTarget
        )).outcome, .reset)
        XCTAssertNil(store.evaluationSnapshot())
    }
}
