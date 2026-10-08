// swiftlint:disable force_unwrapping
import Foundation
@testable import NetworkFilterCore
import XCTest

final class FakeMonotonicClock: MonotonicClock {
    var nanoseconds: UInt64 = 5_000_000_000

    func nowNanoseconds() -> UInt64 {
        nanoseconds
    }

    func advance(milliseconds: UInt64) {
        nanoseconds += milliseconds * 1_000_000
    }
}

enum RuleFixtures {
    static let simulator = ManagedSimulator(
        deviceSet: CapturedSimulator.defaultDeviceSet,
        udid: CapturedSimulator.udid
    )!
    static let sibling = ManagedSimulator(
        deviceSet: CapturedSimulator.defaultDeviceSet,
        udid: "0B9C1F7E-5D3A-4C21-9E8B-7A6F5E4D3C2B"
    )!
    static let bundleId = "dev.jasonpearson.automobile.fixture"
    static let target = NetworkRuleTarget(simulator: simulator, bundleId: bundleId)!

    static func ownership(
        _ owner: String = "session-a",
        generation: UInt64 = 10,
        revision: UInt64
    )
        -> NetworkRuleOwnership
    {
        NetworkRuleOwnership(owner: owner, ownerGeneration: generation, revision: revision)!
    }

    static func apply(
        _ ownership: NetworkRuleOwnership,
        target: NetworkRuleTarget = target,
        leaseMilliseconds: UInt64 = 15000
    )
        -> NetworkRuleCommand
    {
        NetworkRuleCommand(
            kind: .apply,
            target: target,
            ownership: ownership,
            condition: .offline,
            leaseMilliseconds: leaseMilliseconds
        )
    }

    static func reset(_ ownership: NetworkRuleOwnership, target: NetworkRuleTarget = target) -> NetworkRuleCommand {
        NetworkRuleCommand(kind: .reset, target: target, ownership: ownership)
    }

    static func renew(_ ownership: NetworkRuleOwnership, leaseMilliseconds: UInt64 = 15000) -> NetworkRuleCommand {
        NetworkRuleCommand(kind: .renew, target: target, ownership: ownership, leaseMilliseconds: leaseMilliseconds)
    }
}

final class NetworkRuleStoreTests: XCTestCase {
    private var clock = FakeMonotonicClock()
    private var store = NetworkRuleStore(clock: FakeMonotonicClock())

    override func setUp() {
        super.setUp()
        clock = FakeMonotonicClock()
        store = NetworkRuleStore(clock: clock)
    }

    private func outcome(_ command: NetworkRuleCommand) -> NetworkRuleOutcome {
        store.execute(command).outcome
    }

    // MARK: - Apply and idempotency

    func testApplyInstallsTheRuleAndAcknowledgesItsRevision() {
        let result = store.execute(RuleFixtures.apply(RuleFixtures.ownership(revision: 1)))
        XCTAssertEqual(
            result,
            NetworkRuleResult(outcome: .applied, installedRevision: 1, leaseRemainingMilliseconds: 15000)
        )
        let rules = store.activeRules()
        XCTAssertEqual(rules.map(\.target), [RuleFixtures.target])
        XCTAssertEqual(rules.first?.revision, 1)
        XCTAssertEqual(rules.first?.condition, .offline)
    }

    func testReDeliveredApplyOfTheInstalledRevisionIsIdempotent() {
        let ownership = RuleFixtures.ownership(revision: 1)
        XCTAssertEqual(outcome(RuleFixtures.apply(ownership)), .applied)
        let ticket = store.currentTicket(for: RuleFixtures.target)!
        XCTAssertTrue(store.commitDrop(ticket))
        clock.advance(milliseconds: 10000)
        XCTAssertEqual(outcome(RuleFixtures.apply(ownership)), .applied)
        XCTAssertEqual(store.activeRules().count, 1)
        XCTAssertEqual(store.activeRules().first?.droppedFlows, 1, "the same rule keeps its counters")
        XCTAssertEqual(store.activeRules().first?.leaseRemainingMilliseconds, 15000, "re-delivery starts a fresh lease")
    }

    func testOlderRevisionOfTheSameGenerationIsRefusedAndReportsTheInstalledOne() {
        XCTAssertEqual(outcome(RuleFixtures.apply(RuleFixtures.ownership(revision: 3))), .applied)
        let stale = store.execute(RuleFixtures.apply(RuleFixtures.ownership(revision: 2)))
        XCTAssertEqual(stale.outcome, .staleRevision)
        XCTAssertEqual(stale.installedRevision, 3)
    }

    func testOlderGenerationIsRefusedOnceANewerOneInstalled() {
        XCTAssertEqual(outcome(RuleFixtures.apply(RuleFixtures.ownership(generation: 20, revision: 1))), .applied)
        XCTAssertEqual(
            outcome(RuleFixtures.apply(RuleFixtures.ownership(generation: 19, revision: 9))),
            .staleGeneration
        )
        XCTAssertEqual(
            outcome(RuleFixtures.reset(RuleFixtures.ownership(generation: 19, revision: 9))),
            .staleGeneration
        )
        XCTAssertEqual(store.activeRules().first?.ownerGeneration, 20)
    }

    func testLeaseOutsideTheBoundsIsRefused() {
        XCTAssertEqual(
            outcome(RuleFixtures.apply(RuleFixtures.ownership(revision: 1), leaseMilliseconds: 999)),
            .invalidLease
        )
        XCTAssertEqual(
            outcome(RuleFixtures.apply(RuleFixtures.ownership(revision: 1), leaseMilliseconds: 60001)),
            .invalidLease
        )
        XCTAssertTrue(store.activeRules().isEmpty)
    }

    func testApplyWithoutAConditionIsInvalid() {
        let command = NetworkRuleCommand(
            kind: .apply,
            target: RuleFixtures.target,
            ownership: RuleFixtures.ownership(revision: 1),
            leaseMilliseconds: 15000
        )
        XCTAssertEqual(outcome(command), .invalidCommand)
    }

    // MARK: - Reset

    func testResetRemovesTheRuleAndIsIdempotent() {
        XCTAssertEqual(outcome(RuleFixtures.apply(RuleFixtures.ownership(revision: 1))), .applied)
        XCTAssertEqual(outcome(RuleFixtures.reset(RuleFixtures.ownership(revision: 2))), .reset)
        XCTAssertTrue(store.activeRules().isEmpty)
        XCTAssertEqual(outcome(RuleFixtures.reset(RuleFixtures.ownership(revision: 2))), .reset, "a duplicate reset")
        XCTAssertEqual(outcome(RuleFixtures.reset(RuleFixtures.ownership(revision: 3))), .reset, "a later reset")
        XCTAssertNil(store.evaluationSnapshot())
    }

    func testResetWithoutAnyRuleSucceeds() {
        XCTAssertEqual(outcome(RuleFixtures.reset(RuleFixtures.ownership(revision: 1))), .reset)
    }

    func testResetMustCarryANewerRevisionThanTheInstalledApply() {
        XCTAssertEqual(outcome(RuleFixtures.apply(RuleFixtures.ownership(revision: 4))), .applied)
        XCTAssertEqual(outcome(RuleFixtures.reset(RuleFixtures.ownership(revision: 4))), .staleRevision)
        XCTAssertEqual(store.activeRules().count, 1)
    }

    func testLateApplyFromBeforeAResetIsRefused() {
        // The host applied revision 1, timed out, and rolled back with reset 2;
        // the delayed apply then arrives.
        XCTAssertEqual(outcome(RuleFixtures.reset(RuleFixtures.ownership(revision: 2))), .reset)
        XCTAssertEqual(outcome(RuleFixtures.apply(RuleFixtures.ownership(revision: 1))), .staleRevision)
        XCTAssertTrue(store.activeRules().isEmpty)
        XCTAssertEqual(outcome(RuleFixtures.apply(RuleFixtures.ownership(revision: 3))), .applied, "a newer apply")
    }

    func testReleasedGenerationCannotReinstallAfterItsReset() {
        XCTAssertEqual(outcome(RuleFixtures.apply(RuleFixtures.ownership(generation: 10, revision: 1))), .applied)
        XCTAssertEqual(outcome(RuleFixtures.reset(RuleFixtures.ownership(generation: 11, revision: 1))), .reset)
        XCTAssertEqual(
            outcome(RuleFixtures.apply(RuleFixtures.ownership(generation: 10, revision: 5))),
            .staleGeneration
        )
    }

    // MARK: - Ownership across sessions

    func testAnotherSessionsResetCannotClearTheRule() {
        XCTAssertEqual(outcome(RuleFixtures.apply(RuleFixtures.ownership("session-a", revision: 1))), .applied)
        let other = RuleFixtures.ownership("session-b", generation: 99, revision: 50)
        XCTAssertEqual(outcome(RuleFixtures.reset(other)), .ownedByAnotherSession)
        XCTAssertEqual(outcome(RuleFixtures.apply(other)), .ownedByAnotherSession)
        XCTAssertEqual(outcome(RuleFixtures.renew(other)), .notFound)
        XCTAssertEqual(store.activeRules().first?.owner, "session-a")
    }

    func testAnotherSessionMayApplyOnceTheRuleExpired() {
        XCTAssertEqual(outcome(RuleFixtures.apply(RuleFixtures.ownership("session-a", revision: 1))), .applied)
        clock.advance(milliseconds: 15000)
        XCTAssertEqual(outcome(RuleFixtures.apply(RuleFixtures.ownership("session-b", revision: 1))), .applied)
        XCTAssertEqual(store.activeRules().first?.owner, "session-b")
    }

    func testRulesForSiblingSimulatorsAreIndependent() {
        let siblingTarget = NetworkRuleTarget(simulator: RuleFixtures.sibling, bundleId: RuleFixtures.bundleId)!
        XCTAssertEqual(outcome(RuleFixtures.apply(RuleFixtures.ownership("session-a", revision: 1))), .applied)
        XCTAssertEqual(
            outcome(RuleFixtures.apply(RuleFixtures.ownership("session-b", revision: 1), target: siblingTarget)),
            .applied
        )
        XCTAssertEqual(
            outcome(RuleFixtures.reset(RuleFixtures.ownership("session-b", revision: 2), target: siblingTarget)),
            .reset
        )
        XCTAssertEqual(store.activeRules().map(\.target), [RuleFixtures.target])
    }

    // MARK: - Lease

    func testRuleExpiresWithoutRenewal() {
        XCTAssertEqual(
            outcome(RuleFixtures.apply(RuleFixtures.ownership(revision: 1), leaseMilliseconds: 5000)),
            .applied
        )
        clock.advance(milliseconds: 4999)
        XCTAssertNotNil(store.evaluationSnapshot())
        clock.advance(milliseconds: 1)
        XCTAssertNil(store.evaluationSnapshot())
        XCTAssertEqual(outcome(RuleFixtures.renew(RuleFixtures.ownership(revision: 1))), .notFound)
    }

    func testRenewExtendsTheLeaseFromNow() {
        XCTAssertEqual(
            outcome(RuleFixtures.apply(RuleFixtures.ownership(revision: 1), leaseMilliseconds: 5000)),
            .applied
        )
        clock.advance(milliseconds: 4000)
        let renewed = store.execute(RuleFixtures.renew(RuleFixtures.ownership(revision: 1), leaseMilliseconds: 5000))
        XCTAssertEqual(
            renewed,
            NetworkRuleResult(outcome: .renewed, installedRevision: 1, leaseRemainingMilliseconds: 5000)
        )
        clock.advance(milliseconds: 4000)
        XCTAssertEqual(store.activeRules().first?.leaseRemainingMilliseconds, 1000)
    }

    func testRenewOfAnotherRevisionOrGenerationIsRefused() {
        XCTAssertEqual(outcome(RuleFixtures.apply(RuleFixtures.ownership(generation: 10, revision: 2))), .applied)
        XCTAssertEqual(outcome(RuleFixtures.renew(RuleFixtures.ownership(generation: 10, revision: 1))), .staleRevision)
        XCTAssertEqual(
            outcome(RuleFixtures.renew(RuleFixtures.ownership(generation: 9, revision: 2))),
            .staleGeneration
        )
    }

    /// The clock counts sleep (`CLOCK_MONOTONIC`): a lease that elapsed while the
    /// Mac slept is gone at the first flow after wake, with no timer involved.
    func testLeaseElapsedDuringSleepIsExpiredOnWake() {
        XCTAssertEqual(outcome(RuleFixtures.apply(RuleFixtures.ownership(revision: 1))), .applied)
        clock.advance(milliseconds: 3_600_000)
        XCTAssertNil(store.evaluationSnapshot())
    }

    func testExpiredRuleIsFencedAgainstALateApplyOfTheSameRevision() {
        XCTAssertEqual(outcome(RuleFixtures.apply(RuleFixtures.ownership(revision: 1))), .applied)
        clock.advance(milliseconds: 15000)
        XCTAssertTrue(store.activeRules().isEmpty)
        XCTAssertEqual(outcome(RuleFixtures.apply(RuleFixtures.ownership(revision: 1))), .staleRevision)
        XCTAssertEqual(outcome(RuleFixtures.apply(RuleFixtures.ownership(revision: 2))), .applied)
    }

    func testRemoveAllEndsEveryRuleWithoutResurrection() {
        XCTAssertEqual(outcome(RuleFixtures.apply(RuleFixtures.ownership(revision: 1))), .applied)
        store.removeAll()
        XCTAssertNil(store.evaluationSnapshot())
        XCTAssertEqual(outcome(RuleFixtures.renew(RuleFixtures.ownership(revision: 1))), .notFound)
        XCTAssertEqual(outcome(RuleFixtures.apply(RuleFixtures.ownership(revision: 1))), .staleRevision)
    }

    // MARK: - Delayed decisions

    func testDropCommitsOnlyAgainstTheCurrentRule() {
        XCTAssertEqual(outcome(RuleFixtures.apply(RuleFixtures.ownership(revision: 1))), .applied)
        let ticket = store.currentTicket(for: RuleFixtures.target)!
        XCTAssertEqual(outcome(RuleFixtures.reset(RuleFixtures.ownership(revision: 2))), .reset)
        XCTAssertFalse(store.commitDrop(ticket), "a decision computed before the reset")
        XCTAssertEqual(outcome(RuleFixtures.apply(RuleFixtures.ownership(revision: 3))), .applied)
        XCTAssertFalse(store.commitDrop(ticket), "a ticket for a superseded revision")
        XCTAssertTrue(store.commitDrop(store.currentTicket(for: RuleFixtures.target)!))
    }

    func testDropDoesNotCommitAfterExpiry() {
        XCTAssertEqual(outcome(RuleFixtures.apply(RuleFixtures.ownership(revision: 1))), .applied)
        let ticket = store.currentTicket(for: RuleFixtures.target)!
        clock.advance(milliseconds: 15000)
        XCTAssertFalse(store.commitDrop(ticket))
    }

    func testCapacityIsBounded() {
        for index in 0 ..< NetworkRuleStore.maximumRules {
            let target = NetworkRuleTarget(simulator: RuleFixtures.simulator, bundleId: "dev.example.app\(index)")!
            XCTAssertEqual(outcome(RuleFixtures.apply(RuleFixtures.ownership(revision: 1), target: target)), .applied)
        }
        let overflow = NetworkRuleTarget(simulator: RuleFixtures.simulator, bundleId: "dev.example.overflow")!
        XCTAssertEqual(
            outcome(RuleFixtures.apply(RuleFixtures.ownership(revision: 1), target: overflow)),
            .capacityExceeded
        )
    }

    func testTargetAndOwnershipValidation() {
        XCTAssertNil(NetworkRuleTarget(simulator: RuleFixtures.simulator, bundleId: ""))
        XCTAssertNil(NetworkRuleTarget(simulator: RuleFixtures.simulator, bundleId: "dev.example/app"))
        XCTAssertNil(NetworkRuleOwnership(owner: "", ownerGeneration: 1, revision: 1))
        XCTAssertNil(NetworkRuleOwnership(owner: "session", ownerGeneration: 1, revision: 0))
        let json =
            #"{"simulator":{"deviceSet":"/sets","udid":"DFBF2D27-6674-42EA-AFC4-AB702275D1D4"},"bundleId":"a b"}"#
        XCTAssertThrowsError(try JSONDecoder().decode(NetworkRuleTarget.self, from: Data(json.utf8)))
    }
}
