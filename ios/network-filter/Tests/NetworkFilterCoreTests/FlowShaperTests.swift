// swiftlint:disable force_unwrapping
import Foundation
@testable import NetworkFilterCore
import XCTest

final class FakeShapingRuleSource: ShapingRuleSource {
    var rules: [NetworkRuleTarget: ShapingRule] = [:]

    func shapingRule(for target: NetworkRuleTarget) -> ShapingRule? { rules[target] }

    func install(
        _ profile: ShapingProfile,
        target: NetworkRuleTarget = RuleFixtures.target,
        owner: String = "session-a",
        generation: UInt64 = 10,
        revision: UInt64 = 1
    ) {
        rules[target] = ShapingRule(ticket: NetworkRuleTicket(
            target: target, owner: owner, ownerGeneration: generation, revision: revision
        ), profile: profile)
    }
}

final class FlowShaperTests: XCTestCase {
    private var clock = FakeMonotonicClock()
    private var source = FakeShapingRuleSource()
    private lazy var shaper = FlowShaper(clock: clock, ruleSource: source)

    private func flow(_ index: Int = 0) -> UUID {
        UUID(uuidString: String(format: "00000000-0000-0000-0000-%012d", index))!
    }

    private func admit(_ index: Int = 0, transport: FlowTransport = .stream) {
        XCTAssertEqual(
            shaper.newFlow(flow(index), target: RuleFixtures.target, transport: transport),
            .filter(inbound: false, outbound: true, peekBytes: 100)
        )
    }

    private func pause(_ decision: DataDecision, file: StaticString = #filePath, line: UInt = #line) -> FlowPause {
        guard case let .pause(value) = decision else {
            XCTFail("Expected pause, got \(decision)", file: file, line: line)
            return FlowPause(flow: flow(), id: 0, resumeAtNanoseconds: 0, phase: .data(.outbound))
        }
        return value
    }

    private func exhaustTimelinesWhilePaused(revision: UInt64 = 2) -> FlowPause {
        let token = reservedData()
        source.rules.removeValue(forKey: RuleFixtures.target)
        for index in 0 ..< FlowShaper.maximumTimelines {
            source.install(ShapingProfile(outboundBytesPerSecond: 1000)!, target: target(index))
            _ = shaper.newFlow(flow(index + 1), target: target(index), transport: .stream)
        }
        source.install(ShapingProfile(outboundBytesPerSecond: revision == 1 ? 2000 : 1000)!, revision: revision)
        return token
    }

    func testResumeAtTimelineCapacityAllowsAndForgetsPause() {
        let token = exhaustTimelinesWhilePaused()
        XCTAssertEqual(shaper.resume(token), .settled(.allow))
        XCTAssertEqual(shaper.resume(token), .alreadySettled)
        XCTAssertEqual(shaper.data(flow(), direction: .outbound, availableBytes: 100), .allow)
        XCTAssertEqual(shaper.untrackedDataCallbacks, 1)
        XCTAssertEqual(shaper.status().reduce(0) { $0 + $1.pausedFlows }, 0)
        source.rules.removeValue(forKey: target(0))
        admit()
        XCTAssertEqual(shaper.status().first { $0.target == RuleFixtures.target }?.pausedFlows, 0)
    }

    func testDueSameTicketResumeAtCapacityAlwaysSettles() {
        let token = exhaustTimelinesWhilePaused(revision: 1)
        XCTAssertEqual(shaper.resume(token), .notDue(resumeAtNanoseconds: token.resumeAtNanoseconds))
        clock.nanoseconds = token.resumeAtNanoseconds
        XCTAssertEqual(shaper.resume(token), .settled(.allow))
        XCTAssertEqual(shaper.resume(token), .alreadySettled)
        XCTAssertEqual(shaper.data(flow(), direction: .outbound, availableBytes: 100), .allow)
        XCTAssertEqual(shaper.untrackedDataCallbacks, 1)
    }

    func testMissingRuleOnDuplicateAdmissionLatchesAllow() {
        let token = reservedData()
        source.rules.removeAll()
        XCTAssertEqual(shaper.newFlow(flow(), target: RuleFixtures.target, transport: .stream), .allow)
        source.install(ShapingProfile(outboundBytesPerSecond: 1000)!, revision: 2)
        XCTAssertEqual(shaper.data(flow(), direction: .outbound, availableBytes: 100), .allow)
        XCTAssertEqual(shaper.resume(token), .settled(.allow))
        XCTAssertEqual(shaper.resume(token), .alreadySettled)
        XCTAssertEqual(shaper.status().first?.trackedFlows, 0)
    }

    func testDataAtTimelineCapacityDropsAndForgetsPause() {
        let token = exhaustTimelinesWhilePaused()
        XCTAssertEqual(shaper.data(flow(), direction: .outbound, availableBytes: 100), .drop)
        XCTAssertEqual(shaper.resume(token), .alreadySettled)
        XCTAssertEqual(shaper.data(flow(), direction: .outbound, availableBytes: 100), .allow)
        XCTAssertEqual(shaper.untrackedDataCallbacks, 1)
    }

    func testDroppedFlowsReleaseAllCapacityImmediately() {
        source.install(ShapingProfile(outboundDelayMilliseconds: 1)!)
        clock.nanoseconds = UInt64.max - 1
        for index in 0 ..< FlowShaper.maximumFlows {
            _ = shaper.newFlow(flow(index), target: RuleFixtures.target, transport: .datagram)
        }
        XCTAssertEqual(shaper.status().first?.trackedFlows, FlowShaper.maximumFlows)
        for index in 0 ..< FlowShaper.maximumFlows {
            XCTAssertEqual(shaper.data(flow(index), direction: .outbound, availableBytes: 100), .drop)
        }
        XCTAssertEqual(shaper.status().first?.trackedFlows, 0)
        XCTAssertEqual(shaper.status().first?.overBudgetDrops, UInt64(FlowShaper.maximumFlows))
        XCTAssertEqual(shaper.status().first?.outboundHeldBursts, 0)
        XCTAssertEqual(
            shaper.newFlow(flow(256), target: RuleFixtures.target, transport: .datagram),
            .filter(inbound: false, outbound: true, peekBytes: 65536)
        )
        XCTAssertEqual(shaper.status().first?.trackedFlows, 1)
        XCTAssertEqual(shaper.status().first?.refusedFlows, 0)
    }

    func testDatagramOwnDurationBoundaryAndDropLeavesTimelineUnchanged() {
        source.install(ShapingProfile(outboundBytesPerSecond: 1000)!)
        admit(transport: .datagram)
        XCTAssertEqual(
            shaper.data(flow(), direction: .outbound, availableBytes: 8000),
            .pass(bytes: 8000, peekBytes: 100)
        )
        clock.advance(milliseconds: 8000)
        admit(1, transport: .datagram)
        XCTAssertEqual(shaper.data(flow(1), direction: .outbound, availableBytes: 8001), .drop)
        XCTAssertEqual(shaper.status().first?.overBudgetDrops, 1)
        XCTAssertEqual(shaper.status().first?.outboundReleasedBytes, 8000)
        XCTAssertEqual(shaper.status().first?.trackedFlows, 1)
        XCTAssertEqual(
            shaper.data(flow(), direction: .outbound, availableBytes: 100),
            .pass(bytes: 100, peekBytes: 100)
        )
        let next = pause(shaper.data(flow(), direction: .outbound, availableBytes: 100))
        XCTAssertEqual(next.resumeAtNanoseconds, clock.nanoseconds + 100_000_000)
    }

    func testOversizedPausedDatagramDropsBeforeDebtCharge() {
        source.install(ShapingProfile(outboundDelayMilliseconds: 1, outboundBytesPerSecond: 1000)!)
        _ = shaper.newFlow(flow(), target: RuleFixtures.target, transport: .datagram)
        let token = pause(shaper.data(flow(), direction: .outbound, availableBytes: 100))
        XCTAssertEqual(shaper.data(flow(), direction: .outbound, availableBytes: 8001), .drop)
        XCTAssertEqual(shaper.status().first?.debtReleases, 0)
        XCTAssertEqual(shaper.status().first?.overBudgetDrops, 1)
        XCTAssertEqual(shaper.resume(token), .alreadySettled)
        _ = shaper.newFlow(flow(1), target: RuleFixtures.target, transport: .datagram)
        let next = pause(shaper.data(flow(1), direction: .outbound, availableBytes: 100))
        XCTAssertEqual(next.resumeAtNanoseconds, clock.nanoseconds + 100_000_000)
    }

    func testSecondPositivePausedCallbackDropsAcrossDirections() {
        let start = clock.nanoseconds
        let token = reservedData()
        for bytes in [0, -1] {
            XCTAssertEqual(
                shaper.data(flow(), direction: .outbound, availableBytes: bytes),
                .pass(bytes: 0, peekBytes: 200)
            )
        }
        XCTAssertEqual(
            shaper.data(flow(), direction: .outbound, availableBytes: 200),
            .pass(bytes: 200, peekBytes: 200)
        )
        XCTAssertEqual(shaper.status().first?.pausedFlows, 1)
        XCTAssertEqual(shaper.status().first?.debtReleases, 1)
        XCTAssertEqual(shaper.status().first?.outboundReleasedBytes, 400)
        XCTAssertLessThanOrEqual(
            shaper.status().first!.outboundReleasedBytes,
            2000 * (clock.nanoseconds - start) / 1_000_000_000 + (1 + 1) * 200
        )
        XCTAssertEqual(shaper.data(flow(), direction: .inbound, availableBytes: 1), .drop)
        XCTAssertEqual(shaper.status().first?.overBudgetDrops, 1)
        XCTAssertEqual(shaper.status().first?.callbacksWhilePaused, 4)
        XCTAssertEqual(shaper.status().first?.trackedFlows, 0)
        XCTAssertEqual(shaper.status().first?.inboundReleasedBytes, 0)
        XCTAssertEqual(shaper.resume(token), .alreadySettled)
        clock.nanoseconds = token.resumeAtNanoseconds
        XCTAssertEqual(shaper.resume(token), .alreadySettled)
        // The dropped callback did not charge another slot; prior charges persist.
        _ = shaper.newFlow(flow(1), target: RuleFixtures.target, transport: .stream)
        let next = pause(shaper.data(flow(1), direction: .outbound, availableBytes: 200))
        XCTAssertEqual(next.resumeAtNanoseconds, start + 300_000_000)
    }

    func testDebtReleaseLimitSurvivesTicketChangeDuringPause() {
        let token = reservedData()
        _ = shaper.data(flow(), direction: .outbound, availableBytes: 200)
        source.install(ShapingProfile(outboundBytesPerSecond: 1000)!, revision: 2)
        XCTAssertEqual(shaper.data(flow(), direction: .outbound, availableBytes: 100), .drop)
        XCTAssertEqual(shaper.status().first?.debtReleases, 0)
        XCTAssertEqual(shaper.status().first?.overBudgetDrops, 1)
        XCTAssertEqual(shaper.resume(token), .alreadySettled)
    }

    func testAllowLatchSurvivesReinstalledRuleAndEverySettlementPath() {
        for path in 0 ..< 4 {
            let token = reservedData()
            source.rules.removeAll()
            XCTAssertEqual(shaper.data(flow(), direction: .outbound, availableBytes: 100), .allow)
            source.install(ShapingProfile(outboundBytesPerSecond: 1000)!, revision: 2)
            XCTAssertEqual(shaper.data(flow(), direction: .inbound, availableBytes: 100), .allow)
            XCTAssertEqual(shaper.data(flow(), direction: .outbound, availableBytes: 0), .allow)
            XCTAssertEqual(shaper.newFlow(flow(), target: RuleFixtures.target, transport: .stream), .allow)
            clock.nanoseconds = token.resumeAtNanoseconds
            switch path {
            case 0: XCTAssertEqual(shaper.resume(token), .settled(.allow))
            case 1: XCTAssertEqual(shaper.settleStale(), [FlowSettlement(pause: token, decision: .allow)])
            case 2: XCTAssertEqual(shaper.flowEnded(flow()), FlowSettlement(pause: token, decision: .allow))
            default: XCTAssertEqual(shaper.removeAll(), [FlowSettlement(pause: token, decision: .allow)])
            }
            XCTAssertEqual(shaper.resume(token), .alreadySettled)
            XCTAssertEqual(shaper.data(flow(), direction: .outbound, availableBytes: 100), .allow)
            XCTAssertEqual(shaper.status().reduce(0) { $0 + $1.trackedFlows }, 0)
            _ = shaper.removeAll()
        }
    }

    func testTwentyRevisionBumpsCannotEarnFreshFirstGrants() {
        source.install(ShapingProfile(outboundBytesPerSecond: 1000)!)
        let start = clock.nanoseconds
        var released = 0
        var debt = 0
        for revision in 1 ... 20 {
            source.install(ShapingProfile(outboundBytesPerSecond: 1000)!, revision: UInt64(revision))
            admit(revision)
            let decision = shaper.data(flow(revision), direction: .outbound, availableBytes: 100)
            switch decision {
            case let .pass(bytes, _): released += bytes
            case let .pause(token):
                XCTAssertEqual(token.resumeAtNanoseconds, start + UInt64(revision - 1) * 100_000_000)
            default: XCTFail("Expected pass or reservation")
            }
            debt += Int(shaper.status().first!.debtReleases)
        }
        XCTAssertEqual(debt, 0)
        XCTAssertEqual(released, 100)
        XCTAssertLessThanOrEqual(released, (1 + debt) * 100)
        XCTAssertEqual(shaper.status().first?.pausedFlows, 19)
    }

    func testTicketChangeInheritsBothDirectionsAndUnlimitedIgnoresDebt() {
        source.install(ShapingProfile(outboundBytesPerSecond: 1000, inboundBytesPerSecond: 2000)!)
        _ = shaper.newFlow(flow(), target: RuleFixtures.target, transport: .stream)
        _ = shaper.data(flow(), direction: .outbound, availableBytes: 100)
        _ = shaper.data(flow(), direction: .inbound, availableBytes: 200)
        source.install(ShapingProfile(outboundBytesPerSecond: 2000, inboundBytesPerSecond: 1000)!, revision: 2)
        let outbound = pause(shaper.data(flow(), direction: .outbound, availableBytes: 200))
        XCTAssertEqual(outbound.resumeAtNanoseconds, clock.nanoseconds + 100_000_000)
        _ = shaper.newFlow(flow(1), target: RuleFixtures.target, transport: .stream)
        let inbound = pause(shaper.data(flow(1), direction: .inbound, availableBytes: 100))
        XCTAssertEqual(inbound.resumeAtNanoseconds, clock.nanoseconds + 100_000_000)
        source.install(ShapingProfile(outboundBytesPerSecond: 1000)!, revision: 3)
        _ = shaper.newFlow(flow(2), target: RuleFixtures.target, transport: .stream)
        XCTAssertEqual(
            shaper.data(flow(2), direction: .inbound, availableBytes: 10000),
            .pass(bytes: 10000, peekBytes: 65536)
        )
    }

    func testPrunedTimelineStartsFreshAfterRuleReturns() {
        source.install(ShapingProfile(outboundBytesPerSecond: 1000)!)
        admit()
        _ = shaper.data(flow(), direction: .outbound, availableBytes: 100)
        source.rules.removeAll()
        XCTAssertEqual(shaper.settleStale(), [])
        source.install(ShapingProfile(outboundBytesPerSecond: 1000)!, revision: 2)
        XCTAssertEqual(
            shaper.data(flow(), direction: .outbound, availableBytes: 100),
            .pass(bytes: 100, peekBytes: 100)
        )
    }

    func testFastPingPongWithOnlyOneDelayedDirectionHoldsOnce() {
        latencyFlow(ShapingProfile(outboundDelayMilliseconds: 30)!)
        let first = pause(shaper.data(flow(), direction: .outbound, availableBytes: 10))
        clock.nanoseconds = first.resumeAtNanoseconds
        _ = shaper.resume(first)
        for _ in 0 ..< 4 {
            clock.advance(milliseconds: 1)
            XCTAssertEqual(
                shaper.data(flow(), direction: .inbound, availableBytes: 10),
                .pass(bytes: 10, peekBytes: 65536)
            )
            XCTAssertEqual(
                shaper.data(flow(), direction: .outbound, availableBytes: 10),
                .pass(bytes: 10, peekBytes: 65536)
            )
        }
        XCTAssertEqual(shaper.status().first?.outboundHeldBursts, 1)
        XCTAssertEqual(shaper.status().first?.inboundHeldBursts, 0)
    }

    func testNoRuleAllowsAndTracksNothing() {
        XCTAssertEqual(shaper.newFlow(flow(), target: RuleFixtures.target, transport: .stream), .allow)
        XCTAssertEqual(shaper.data(flow(), direction: .outbound, availableBytes: 100), .allow)
        XCTAssertEqual(shaper.untrackedDataCallbacks, 1)
        XCTAssertEqual(shaper.status(), [])
    }

    func testStreamConnectionHoldAndShapedDirections() {
        source.install(ShapingProfile(outboundDelayMilliseconds: 3)!)
        guard case let .pause(token) = shaper.newFlow(flow(), target: RuleFixtures.target, transport: .stream) else {
            return XCTFail("Expected connection hold")
        }
        XCTAssertEqual(token.phase, .newFlow)
        XCTAssertEqual(token.resumeAtNanoseconds, clock.nanoseconds + 3_000_000)
        clock.nanoseconds = token.resumeAtNanoseconds
        XCTAssertEqual(shaper.resume(token), .settled(.filter(inbound: false, outbound: true, peekBytes: 65536)))
    }

    func testStreamConnectionHoldIsOneRoundTrip() {
        source.install(ShapingProfile(outboundDelayMilliseconds: 30, inboundDelayMilliseconds: 20)!)
        guard case let .pause(token) = shaper.newFlow(flow(), target: RuleFixtures.target, transport: .stream) else {
            return XCTFail("Expected connection hold")
        }
        XCTAssertEqual(token.resumeAtNanoseconds, clock.nanoseconds + 50_000_000)
        clock.nanoseconds = token.resumeAtNanoseconds
        XCTAssertEqual(shaper.resume(token), .settled(.filter(inbound: true, outbound: true, peekBytes: 65536)))
    }

    func testDatagramNewFlowIsNotHeld() {
        source.install(ShapingProfile(outboundDelayMilliseconds: 10, inboundDelayMilliseconds: 10)!)
        XCTAssertEqual(
            shaper.newFlow(flow(), target: RuleFixtures.target, transport: .datagram),
            .filter(inbound: true, outbound: true, peekBytes: 65536)
        )
        XCTAssertEqual(shaper.status().first?.pausedFlows, 0)
    }

    func testSingleFlowHasExactQuantumAndSpacing() {
        source.install(ShapingProfile(outboundBytesPerSecond: 1000)!)
        admit()
        XCTAssertEqual(
            shaper.data(flow(), direction: .outbound, availableBytes: 500),
            .pass(bytes: 100, peekBytes: 100)
        )
        for _ in 0 ..< 10 {
            let token = pause(shaper.data(flow(), direction: .outbound, availableBytes: 500))
            XCTAssertEqual(token.resumeAtNanoseconds, clock.nanoseconds + 100_000_000)
            clock.nanoseconds = token.resumeAtNanoseconds
            XCTAssertEqual(shaper.resume(token), .settled(.pass(bytes: 100, peekBytes: 100)))
        }
        XCTAssertEqual(shaper.status().first?.outboundReleasedBytes, 1100)
    }

    func testIntegerArithmeticRoundsUp() {
        source.install(ShapingProfile(outboundBytesPerSecond: 1001)!)
        admit()
        XCTAssertEqual(
            shaper.data(flow(), direction: .outbound, availableBytes: 100),
            .pass(bytes: 100, peekBytes: 100)
        )
        let token = pause(shaper.data(flow(), direction: .outbound, availableBytes: 100))
        XCTAssertEqual(token.resumeAtNanoseconds - clock.nanoseconds, 99_900_100)
        clock.nanoseconds = token.resumeAtNanoseconds - 1
        XCTAssertEqual(shaper.resume(token), .notDue(resumeAtNanoseconds: token.resumeAtNanoseconds))
        clock.nanoseconds += 1
        XCTAssertEqual(shaper.resume(token), .settled(.pass(bytes: 100, peekBytes: 100)))
    }

    private func driveConcurrent(_ count: Int) {
        let rate: UInt64 = 10000
        let quantum = 1000
        source.install(ShapingProfile(outboundBytesPerSecond: rate)!)
        let start = clock.nanoseconds
        let end = start + 10_000_000_000
        var pending: [FlowPause] = []
        var totals = Array(repeating: 0, count: count)
        var events: [(UInt64, Int)] = []
        var immediate: [Int] = []
        for index in 0 ..< count {
            _ = shaper.newFlow(flow(index), target: RuleFixtures.target, transport: .stream)
            switch shaper.data(flow(index), direction: .outbound, availableBytes: quantum) {
            case let .pass(bytes, _):
                totals[index] += bytes
                events.append((clock.nanoseconds, bytes))
                immediate.append(index)
            case let .pause(token): pending.append(token)
            default: XCTFail("Unexpected admission verdict")
            }
        }
        // All concurrent flows offer their first grant before any re-offer.
        for index in immediate {
            pending.append(pause(shaper.data(flow(index), direction: .outbound, availableBytes: quantum)))
        }
        while let token = pending.min(by: { ($0.resumeAtNanoseconds, $0.id) < ($1.resumeAtNanoseconds, $1.id) }),
              token.resumeAtNanoseconds <= end
        {
            pending.removeAll { $0.id == token.id }
            clock.nanoseconds = token.resumeAtNanoseconds
            guard case let .settled(.pass(bytes, _)) = shaper.resume(token) else { return XCTFail("Expected grant") }
            let index = (0 ..< count).first { flow($0) == token.flow }!
            totals[index] += bytes
            events.append((clock.nanoseconds, bytes))
            pending.append(pause(shaper.data(token.flow, direction: .outbound, availableBytes: quantum)))
        }
        let total = totals.reduce(0, +)
        XCTAssertLessThanOrEqual(total, Int(rate * 10) + quantum)
        XCTAssertGreaterThanOrEqual(total, Int(rate * 9))
        for bytes in totals {
            XCTAssertLessThanOrEqual(abs(bytes - total / count), quantum)
        }
        XCTAssertEqual(shaper.status().first?.debtReleases, 0)
        // Every release-aligned subwindow, not just the cumulative total.
        for first in events.indices {
            for last in first ..< events.count {
                let released = (last - first + 1) * quantum
                let elapsed = events[last].0 - events[first].0
                XCTAssertLessThanOrEqual(UInt64(released), rate * elapsed / 1_000_000_000 + UInt64(quantum))
            }
        }
    }

    func testThreeConcurrentFlowsShareAggregateBudgetFairly() { driveConcurrent(3) }
    func testSixteenConcurrentFlowsShareAggregateBudgetFairly() { driveConcurrent(16) }

    func testDirectionalBudgetsAreIndependent() {
        source.install(ShapingProfile(outboundBytesPerSecond: 1000, inboundBytesPerSecond: 2000)!)
        _ = shaper.newFlow(flow(), target: RuleFixtures.target, transport: .stream)
        XCTAssertEqual(
            shaper.data(flow(), direction: .outbound, availableBytes: 500),
            .pass(bytes: 100, peekBytes: 100)
        )
        XCTAssertEqual(shaper.data(flow(), direction: .inbound, availableBytes: 500), .pass(bytes: 200, peekBytes: 200))
        XCTAssertEqual(shaper.status().first?.inboundReleasedBytes, 200)
    }

    func testUnlimitedDirectionPassesEverything() {
        source.install(ShapingProfile(outboundBytesPerSecond: 1000)!)
        admit()
        XCTAssertEqual(
            shaper.data(flow(), direction: .inbound, availableBytes: 1_000_000),
            .pass(bytes: 1_000_000, peekBytes: 65536)
        )
    }

    func testLongIdleDoesNotAccumulateCredit() {
        source.install(ShapingProfile(outboundBytesPerSecond: 1000)!)
        admit()
        _ = shaper.data(flow(), direction: .outbound, availableBytes: 100)
        clock.advance(milliseconds: 100_000)
        XCTAssertEqual(
            shaper.data(flow(), direction: .outbound, availableBytes: 100),
            .pass(bytes: 100, peekBytes: 100)
        )
        let token = pause(shaper.data(flow(), direction: .outbound, availableBytes: 100))
        XCTAssertEqual(token.resumeAtNanoseconds, clock.nanoseconds + 100_000_000)
    }

    private func latencyFlow(_ profile: ShapingProfile) {
        source.install(profile)
        _ = shaper.newFlow(flow(), target: RuleFixtures.target, transport: .datagram)
    }

    func testFirstDataIsHeld() {
        latencyFlow(ShapingProfile(outboundDelayMilliseconds: 30)!)
        let token = pause(shaper.data(flow(), direction: .outbound, availableBytes: 500))
        XCTAssertEqual(token.resumeAtNanoseconds, clock.nanoseconds + 30_000_000)
        clock.nanoseconds = token.resumeAtNanoseconds
        XCTAssertEqual(shaper.resume(token), .settled(.pass(bytes: 500, peekBytes: 65536)))
        XCTAssertEqual(shaper.status().first?.outboundHeldBursts, 1)
    }

    func testContinuousDataIsNotHeldAgain() {
        latencyFlow(ShapingProfile(outboundDelayMilliseconds: 30)!)
        let token = pause(shaper.data(flow(), direction: .outbound, availableBytes: 500))
        clock.nanoseconds = token.resumeAtNanoseconds
        _ = shaper.resume(token)
        for _ in 0 ..< 5 {
            clock.advance(milliseconds: 10)
            XCTAssertEqual(
                shaper.data(flow(), direction: .outbound, availableBytes: 500),
                .pass(bytes: 500, peekBytes: 65536)
            )
        }
        XCTAssertEqual(shaper.status().first?.outboundHeldBursts, 1)
    }

    func testQuietGapStartsAnotherHold() {
        latencyFlow(ShapingProfile(outboundDelayMilliseconds: 30, inboundDelayMilliseconds: 20)!)
        let first = pause(shaper.data(flow(), direction: .outbound, availableBytes: 500))
        clock.nanoseconds = first.resumeAtNanoseconds
        _ = shaper.resume(first)
        clock.advance(milliseconds: 20)
        let second = pause(shaper.data(flow(), direction: .outbound, availableBytes: 500))
        XCTAssertEqual(second.resumeAtNanoseconds, clock.nanoseconds + 30_000_000)
        XCTAssertEqual(shaper.status().first?.outboundHeldBursts, 2)
    }

    func testPingPongAddsRoundTripOnEveryExchange() {
        latencyFlow(ShapingProfile(outboundDelayMilliseconds: 30, inboundDelayMilliseconds: 20)!)
        for _ in 0 ..< 4 {
            let start = clock.nanoseconds
            let upload = pause(shaper.data(flow(), direction: .outbound, availableBytes: 10))
            clock.nanoseconds = upload.resumeAtNanoseconds
            _ = shaper.resume(upload)
            let download = pause(shaper.data(flow(), direction: .inbound, availableBytes: 10))
            clock.nanoseconds = download.resumeAtNanoseconds
            _ = shaper.resume(download)
            XCTAssertEqual(clock.nanoseconds - start, 50_000_000)
        }
        XCTAssertEqual(shaper.status().first?.outboundHeldBursts, 4)
        XCTAssertEqual(shaper.status().first?.inboundHeldBursts, 4)
    }

    func testHeldFlowDoesNotBlockAnotherSlotAndWindowBoundHolds() {
        source.install(ShapingProfile(outboundDelayMilliseconds: 200, outboundBytesPerSecond: 1000)!)
        for index in 0 ..< 3 {
            _ = shaper.newFlow(flow(index), target: RuleFixtures.target, transport: .datagram)
        }
        // Prime one flow, so its continuous callback has no latency hold.
        let first = pause(shaper.data(flow(0), direction: .outbound, availableBytes: 100))
        clock.nanoseconds = first.resumeAtNanoseconds
        _ = shaper.resume(first)
        let start = clock.nanoseconds
        let held = pause(shaper.data(flow(1), direction: .outbound, availableBytes: 100))
        clock.advance(milliseconds: 100)
        // Slot at start+100ms is free even though flow 1 is held until +200ms.
        XCTAssertEqual(
            shaper.data(flow(0), direction: .outbound, availableBytes: 100),
            .pass(bytes: 100, peekBytes: 100)
        )
        let third = pause(shaper.data(flow(2), direction: .outbound, availableBytes: 100))
        XCTAssertEqual(third.resumeAtNanoseconds, start + 300_000_000)
        var events: [(UInt64, UInt64)] = [(clock.nanoseconds, 100)]
        for token in [held, third] {
            clock.nanoseconds = token.resumeAtNanoseconds
            XCTAssertEqual(shaper.resume(token), .settled(.pass(bytes: 100, peekBytes: 100)))
            events.append((clock.nanoseconds, 100))
        }
        for firstIndex in events.indices {
            for lastIndex in firstIndex ..< events.count {
                let total = UInt64(lastIndex - firstIndex + 1) * 100
                let elapsed = events[lastIndex].0 - events[firstIndex].0
                XCTAssertLessThanOrEqual(total, 1000 * (elapsed + 200_000_000) / 1_000_000_000 + 100)
            }
        }
        XCTAssertLessThanOrEqual(shaper.status().first!.outboundReleasedBytes, 1000 * 500 / 1000 + 100)
    }

    func testDatagramIsNeverSplitAndChargedInFull() {
        source.install(ShapingProfile(outboundBytesPerSecond: 1000)!)
        admit(transport: .datagram)
        XCTAssertEqual(
            shaper.data(flow(), direction: .outbound, availableBytes: 1234),
            .pass(bytes: 1234, peekBytes: 100)
        )
        let token = pause(shaper.data(flow(), direction: .outbound, availableBytes: 1234))
        XCTAssertEqual(token.resumeAtNanoseconds, clock.nanoseconds + 1_234_000_000)
        clock.nanoseconds = token.resumeAtNanoseconds
        XCTAssertEqual(shaper.resume(token), .settled(.pass(bytes: 1234, peekBytes: 100)))
    }

    func testDatagramOverEightSecondWaitDropsWithoutCharge() {
        source.install(ShapingProfile(outboundBytesPerSecond: 1000)!)
        admit(transport: .datagram)
        XCTAssertEqual(
            shaper.data(flow(), direction: .outbound, availableBytes: 8000),
            .pass(bytes: 8000, peekBytes: 100)
        )
        admit(1, transport: .datagram)
        let token = pause(shaper.data(flow(1), direction: .outbound, availableBytes: 8000))
        admit(2, transport: .datagram)
        XCTAssertEqual(shaper.data(flow(2), direction: .outbound, availableBytes: 4000), .drop)
        XCTAssertEqual(shaper.data(flow(2), direction: .outbound, availableBytes: 100), .allow)
        XCTAssertEqual(shaper.status().first?.overBudgetDrops, 1)
        XCTAssertEqual(shaper.status().first?.trackedFlows, 2)
        clock.nanoseconds = token.resumeAtNanoseconds
        XCTAssertEqual(shaper.resume(token), .settled(.pass(bytes: 8000, peekBytes: 100)))
        clock.advance(milliseconds: 8000)
        XCTAssertEqual(
            shaper.data(flow(), direction: .outbound, availableBytes: 100),
            .pass(bytes: 100, peekBytes: 100)
        )
    }

    func testDroppedDatagramLeavesNoDirectionActivityOrCharge() {
        source.install(ShapingProfile(outboundBytesPerSecond: 1000)!)
        for index in 0 ..< 3 {
            admit(index, transport: .datagram)
        }
        _ = shaper.data(flow(0), direction: .outbound, availableBytes: 8000)
        _ = shaper.data(flow(1), direction: .outbound, availableBytes: 8000)
        XCTAssertEqual(shaper.data(flow(2), direction: .outbound, availableBytes: 100), .drop)
        XCTAssertEqual(shaper.status().first?.outboundHeldBursts, 0)
        // Ignoring the inherited rate budget exposes whether dropped activity survived.
        source.install(ShapingProfile(outboundDelayMilliseconds: 30)!, revision: 2)
        _ = shaper.newFlow(flow(2), target: RuleFixtures.target, transport: .datagram)
        let token = pause(shaper.data(flow(2), direction: .outbound, availableBytes: 100))
        XCTAssertEqual(token.resumeAtNanoseconds, clock.nanoseconds + 30_000_000)
        XCTAssertEqual(shaper.status().first?.outboundHeldBursts, 1)
        XCTAssertEqual(shaper.status().first?.outboundReleasedBytes, 0)
        // Returning to a rate limit preserves only the two accepted 8s charges.
        source.install(ShapingProfile(outboundBytesPerSecond: 1000)!, revision: 3)
        _ = shaper.flowEnded(flow(2))
        clock.advance(milliseconds: 16000)
        XCTAssertEqual(
            shaper.data(flow(0), direction: .outbound, availableBytes: 100),
            .pass(bytes: 100, peekBytes: 100)
        )
    }

    func testDatagramExactlyEightSecondPauseIsAllowed() {
        source.install(ShapingProfile(outboundBytesPerSecond: 1000)!)
        admit(transport: .datagram)
        _ = shaper.data(flow(), direction: .outbound, availableBytes: 8000)
        let token = pause(shaper.data(flow(), direction: .outbound, availableBytes: 1))
        XCTAssertEqual(token.resumeAtNanoseconds - clock.nanoseconds, FlowShaper.maximumDatagramPauseNanoseconds)
    }

    func testDatagramSharedDirectionMakesStreamWaitAboveLimitDrop() {
        source.install(ShapingProfile(outboundBytesPerSecond: 1000)!)
        admit(0, transport: .datagram)
        admit(1, transport: .datagram)
        _ = shaper.data(flow(0), direction: .outbound, availableBytes: 8000)
        _ = shaper.data(flow(1), direction: .outbound, availableBytes: 8000)
        for index in 2 ..< FlowShaper.maximumFlows {
            admit(index)
            let decision = shaper.data(flow(index), direction: .outbound, availableBytes: 100)
            if index <= 142 {
                let token = pause(decision)
                XCTAssertEqual(
                    token.resumeAtNanoseconds,
                    clock.nanoseconds + 16_000_000_000 + UInt64(index - 2) * 100_000_000
                )
                XCTAssertLessThanOrEqual(
                    token.resumeAtNanoseconds - clock.nanoseconds,
                    FlowShaper.maximumStreamPauseNanoseconds
                )
            } else { XCTAssertEqual(decision, .drop) }
        }
        XCTAssertEqual(shaper.status().first?.trackedFlows, 143)
        XCTAssertEqual(shaper.status().first?.pausedFlows, 142)
        XCTAssertEqual(shaper.status().first?.overBudgetDrops, 113)
    }

    func testAllStreamWaitsAtFlowCapAreUnderThirtySeconds() {
        source.install(ShapingProfile(outboundBytesPerSecond: 1000)!)
        for index in 0 ..< FlowShaper.maximumFlows {
            admit(index)
            let decision = shaper.data(flow(index), direction: .outbound, availableBytes: 10000)
            if index == 0 { XCTAssertEqual(decision, .pass(bytes: 100, peekBytes: 100)) }
            else {
                let token = pause(decision)
                XCTAssertEqual(token.resumeAtNanoseconds - clock.nanoseconds, UInt64(index) * 100_000_000)
                XCTAssertLessThan(
                    token.resumeAtNanoseconds - clock.nanoseconds,
                    FlowShaper.maximumStreamPauseNanoseconds
                )
            }
        }
    }

    private func reservedData() -> FlowPause {
        source.install(ShapingProfile(outboundBytesPerSecond: 2000)!)
        _ = shaper.newFlow(flow(), target: RuleFixtures.target, transport: .stream)
        _ = shaper.data(flow(), direction: .outbound, availableBytes: 200)
        return pause(shaper.data(flow(), direction: .outbound, availableBytes: 200))
    }

    func testRemovedRuleResumeAllowsAndForgetsFlow() {
        let token = reservedData()
        source.rules.removeAll()
        XCTAssertEqual(shaper.resume(token), .settled(.allow))
        XCTAssertEqual(shaper.data(flow(), direction: .outbound, availableBytes: 10), .allow)
        XCTAssertEqual(shaper.status(), [])
    }

    private func replacement(owner: String = "session-a", generation: UInt64 = 10, revision: UInt64 = 1) {
        let token = reservedData()
        source.install(
            ShapingProfile(outboundDelayMilliseconds: 2000, outboundBytesPerSecond: 1000)!,
            owner: owner,
            generation: generation,
            revision: revision
        )
        XCTAssertEqual(shaper.resume(token), .settled(.pass(bytes: 100, peekBytes: 100)))
        XCTAssertEqual(shaper.resume(token), .alreadySettled)
        let current = shaper.status().first!
        XCTAssertEqual(current.outboundReleasedBytes, 100)
        XCTAssertEqual(current.debtReleases, 1)
        XCTAssertEqual(current.outboundHeldBursts, 0)
        XCTAssertEqual(current.owner, owner)
        XCTAssertEqual(current.ownerGeneration, generation)
        XCTAssertEqual(current.revision, revision)
        // Two prior 100ms reservations survive, then the new 100ms debt grant.
        let next = pause(shaper.data(flow(), direction: .outbound, availableBytes: 100))
        XCTAssertEqual(next.resumeAtNanoseconds, clock.nanoseconds + 300_000_000)
    }

    func testRevisionBumpSettlesUnderCurrentRule() { replacement(revision: 2) }
    func testGenerationChangeSettlesUnderCurrentRule() { replacement(generation: 11) }
    func testOwnerChangeSettlesUnderCurrentRule() { replacement(owner: "session-b") }

    func testReplacedNewFlowFiltersCurrentProfileWithoutPausing() {
        source.install(ShapingProfile(outboundDelayMilliseconds: 10)!)
        guard case let .pause(token) = shaper.newFlow(flow(), target: RuleFixtures.target, transport: .stream) else {
            return XCTFail("Expected new-flow hold")
        }
        source.install(ShapingProfile(inboundBytesPerSecond: 1000)!, revision: 2)
        XCTAssertEqual(shaper.resume(token), .settled(.filter(inbound: true, outbound: false, peekBytes: 100)))
        XCTAssertEqual(shaper.resume(token), .alreadySettled)
        XCTAssertEqual(shaper.status().first?.debtReleases, 0)
    }

    func testRenewedSameTicketPreservesReservation() {
        let token = reservedData()
        source.install(ShapingProfile(outboundBytesPerSecond: 2000)!)
        XCTAssertEqual(shaper.resume(token), .notDue(resumeAtNanoseconds: token.resumeAtNanoseconds))
        clock.nanoseconds = token.resumeAtNanoseconds
        XCTAssertEqual(shaper.resume(token), .settled(.pass(bytes: 200, peekBytes: 200)))
        XCTAssertEqual(shaper.status().first?.outboundReleasedBytes, 400)
        XCTAssertEqual(shaper.status().first?.debtReleases, 0)
    }

    func testUnpausedCallbackRechecksMissingRule() {
        source.install(ShapingProfile(outboundBytesPerSecond: 1000)!)
        admit()
        source.rules.removeAll()
        XCTAssertEqual(shaper.data(flow(), direction: .outbound, availableBytes: 10), .allow)
        XCTAssertEqual(shaper.data(flow(), direction: .outbound, availableBytes: 10), .allow)
        XCTAssertEqual(shaper.untrackedDataCallbacks, 1)
    }

    func testUnpausedCallbackInheritsTimelineAfterReplacement() {
        source.install(ShapingProfile(outboundBytesPerSecond: 1000)!)
        admit()
        _ = shaper.data(flow(), direction: .outbound, availableBytes: 100)
        source.install(ShapingProfile(outboundBytesPerSecond: 2000)!, revision: 2)
        let token = pause(shaper.data(flow(), direction: .outbound, availableBytes: 1000))
        XCTAssertEqual(token.resumeAtNanoseconds, clock.nanoseconds + 100_000_000)
        XCTAssertEqual(shaper.status().first?.outboundReleasedBytes, 0)
        clock.nanoseconds = token.resumeAtNanoseconds
        XCTAssertEqual(shaper.resume(token), .settled(.pass(bytes: 200, peekBytes: 200)))
        XCTAssertEqual(shaper.status().first?.outboundReleasedBytes, 200)
    }

    func testSettleStaleCancelsLateTimerExactlyOnce() {
        let token = reservedData()
        source.rules.removeAll()
        XCTAssertEqual(shaper.settleStale(), [FlowSettlement(pause: token, decision: .allow)])
        XCTAssertEqual(shaper.resume(token), .alreadySettled)
        XCTAssertEqual(shaper.settleStale(), [])
    }

    func testFlowEndedSettlesPauseExactlyOnce() {
        let token = reservedData()
        XCTAssertEqual(shaper.flowEnded(flow()), FlowSettlement(pause: token, decision: .allow))
        XCTAssertEqual(shaper.resume(token), .alreadySettled)
        XCTAssertNil(shaper.flowEnded(flow()))
    }

    func testRemoveAllSettlesInPauseOrderExactlyOnce() {
        source.install(ShapingProfile(outboundDelayMilliseconds: 10)!)
        var tokens: [FlowPause] = []
        for index in [3, 2, 1] {
            guard case let .pause(token) = shaper.newFlow(flow(index), target: RuleFixtures.target, transport: .stream)
            else { return XCTFail("Expected pause") }
            tokens.append(token)
        }
        XCTAssertEqual(shaper.removeAll(), tokens.map { FlowSettlement(pause: $0, decision: .allow) })
        XCTAssertEqual(shaper.removeAll(), [])
        for token in tokens {
            XCTAssertEqual(shaper.resume(token), .alreadySettled)
        }
        XCTAssertEqual(shaper.status(), [])
    }

    func testDoubleResumeReturnsAlreadySettled() {
        let token = reservedData()
        clock.nanoseconds = token.resumeAtNanoseconds
        XCTAssertEqual(shaper.resume(token), .settled(.pass(bytes: 200, peekBytes: 200)))
        XCTAssertEqual(shaper.resume(token), .alreadySettled)
    }

    func testFlowCapRefusesWhenNothingEvictable() {
        source.install(ShapingProfile(outboundBytesPerSecond: 1000)!)
        for index in 0 ..< 256 {
            admit(index)
        }
        XCTAssertEqual(shaper.newFlow(flow(256), target: RuleFixtures.target, transport: .stream), .drop)
        XCTAssertEqual(shaper.status().first?.refusedFlows, 1)
        XCTAssertEqual(shaper.status().first?.trackedFlows, 256)
    }

    func testFlowCapEvictsLeastActiveIdleFlow() {
        source.install(ShapingProfile(outboundBytesPerSecond: 1000)!)
        for index in 0 ..< 256 {
            admit(index)
        }
        clock.advance(milliseconds: 60000)
        _ = shaper.data(flow(0), direction: .outbound, availableBytes: 1)
        admit(256)
        XCTAssertEqual(shaper.data(flow(1), direction: .outbound, availableBytes: 1), .allow)
        XCTAssertEqual(shaper.untrackedDataCallbacks, 1)
        XCTAssertEqual(shaper.status().first?.trackedFlows, 256)
    }

    func testPausedFlowsCannotBeEvictedEvenWhenIdle() {
        source.install(ShapingProfile(outboundDelayMilliseconds: 10)!)
        for index in 0 ..< 256 {
            guard case .pause = shaper.newFlow(flow(index), target: RuleFixtures.target, transport: .stream) else {
                return XCTFail("Expected hold")
            }
        }
        clock.advance(milliseconds: 60000)
        XCTAssertEqual(shaper.newFlow(flow(256), target: RuleFixtures.target, transport: .stream), .drop)
        XCTAssertEqual(shaper.status().first?.pausedFlows, 256)
    }

    private func target(_ index: Int) -> NetworkRuleTarget {
        NetworkRuleTarget(simulator: RuleFixtures.simulator, bundleId: "app.\(index)")!
    }

    func testSixtyFifthTimelineIsRefusedAndCounted() {
        for index in 0 ..< 65 {
            source.install(ShapingProfile(outboundBytesPerSecond: 1000)!, target: target(index))
            let decision = shaper.newFlow(flow(index), target: target(index), transport: .stream)
            XCTAssertEqual(decision, index < 64 ? .filter(inbound: false, outbound: true, peekBytes: 100) : .drop)
        }
        XCTAssertEqual(shaper.status().first { $0.target == target(64) }?.refusedFlows, 1)
    }

    func testStaleTimelinesArePrunedAndCapacityReused() {
        for index in 0 ..< 64 {
            source.install(ShapingProfile(outboundDelayMilliseconds: 10)!, target: target(index))
            _ = shaper.newFlow(flow(index), target: target(index), transport: .stream)
        }
        source.rules.removeAll()
        let settled = shaper.settleStale()
        XCTAssertEqual(settled.count, 64)
        XCTAssertEqual(settled.map { $0.pause.id }, settled.map { $0.pause.id }.sorted())
        for token in settled {
            XCTAssertEqual(shaper.resume(token.pause), .alreadySettled)
        }
        source.install(ShapingProfile(outboundBytesPerSecond: 1000)!, target: target(64))
        XCTAssertEqual(
            shaper.newFlow(flow(64), target: target(64), transport: .stream),
            .filter(inbound: false, outbound: true, peekBytes: 100)
        )
    }

    func testAdmissionPrunesInactiveTimelines() {
        for index in 0 ..< 64 {
            source.install(ShapingProfile(outboundBytesPerSecond: 1000)!, target: target(index))
            _ = shaper.newFlow(flow(index), target: target(index), transport: .stream)
        }
        source.rules.removeValue(forKey: target(0))
        source.install(ShapingProfile(outboundBytesPerSecond: 1000)!, target: target(64))
        XCTAssertEqual(
            shaper.newFlow(flow(64), target: target(64), transport: .stream),
            .filter(inbound: false, outbound: true, peekBytes: 100)
        )
    }

    func testCallbackWhilePausedPassesDebtAndPreservesPause() {
        let token = reservedData()
        XCTAssertEqual(
            shaper.data(flow(), direction: .outbound, availableBytes: 1000),
            .pass(bytes: 200, peekBytes: 200)
        )
        XCTAssertEqual(shaper.status().first?.callbacksWhilePaused, 1)
        XCTAssertEqual(shaper.status().first?.debtReleases, 1)
        XCTAssertEqual(shaper.status().first?.pausedFlows, 1)
        clock.nanoseconds = token.resumeAtNanoseconds
        XCTAssertEqual(shaper.resume(token), .settled(.pass(bytes: 200, peekBytes: 200)))
        let next = pause(shaper.data(flow(), direction: .outbound, availableBytes: 1000))
        XCTAssertEqual(next.resumeAtNanoseconds, clock.nanoseconds + 200_000_000)
        // 600 bytes released with D=1: rate*T + (1+D)*quantum = 600.
        XCTAssertEqual(shaper.status().first?.outboundReleasedBytes, 600)
    }

    func testOppositeDirectionCallbackWhilePausedIsDebt() {
        let token = reservedData()
        XCTAssertEqual(
            shaper.data(flow(), direction: .inbound, availableBytes: 12345),
            .pass(bytes: 12345, peekBytes: 65536)
        )
        XCTAssertEqual(shaper.status().first?.debtReleases, 1)
        clock.nanoseconds = token.resumeAtNanoseconds
        XCTAssertEqual(shaper.resume(token), .settled(.pass(bytes: 200, peekBytes: 200)))
    }

    func testNonPositiveDataDoesNotChargeOrCountDebt() {
        let token = reservedData()
        for bytes in [0, -1, Int.min] {
            XCTAssertEqual(
                shaper.data(flow(), direction: .outbound, availableBytes: bytes),
                .pass(bytes: 0, peekBytes: 200)
            )
        }
        XCTAssertEqual(shaper.status().first?.debtReleases, 0)
        clock.nanoseconds = token.resumeAtNanoseconds
        _ = shaper.resume(token)
        let next = pause(shaper.data(flow(), direction: .outbound, availableBytes: 200))
        XCTAssertEqual(next.resumeAtNanoseconds, clock.nanoseconds + 100_000_000)
    }

    func testBackwardsClockCannotGrantEarlyOrUnderflow() {
        let token = reservedData()
        clock.nanoseconds = 1
        XCTAssertEqual(shaper.resume(token), .notDue(resumeAtNanoseconds: token.resumeAtNanoseconds))
        XCTAssertEqual(shaper.status().first?.outboundReleasedBytes, 200)
        clock.nanoseconds = token.resumeAtNanoseconds
        XCTAssertEqual(shaper.resume(token), .settled(.pass(bytes: 200, peekBytes: 200)))
        clock.nanoseconds = 0
        let next = pause(shaper.data(flow(), direction: .outbound, availableBytes: 200))
        XCTAssertEqual(next.resumeAtNanoseconds, token.resumeAtNanoseconds + 100_000_000)
    }

    func testStatusIsCodableDeterministicAndRefreshesTicket() throws {
        source.install(ShapingProfile(outboundBytesPerSecond: 1000)!, target: target(2))
        source.install(ShapingProfile(outboundBytesPerSecond: 1000)!, target: target(1))
        _ = shaper.newFlow(flow(2), target: target(2), transport: .stream)
        _ = shaper.newFlow(flow(1), target: target(1), transport: .stream)
        XCTAssertEqual(shaper.status().map(\.target), [target(1), target(2)])
        let token = pause({
            _ = shaper.data(flow(1), direction: .outbound, availableBytes: 100)
            return shaper.data(flow(1), direction: .outbound, availableBytes: 100)
        }())
        XCTAssertEqual(shaper.status().first?.pausedFlows, 1)
        source.install(ShapingProfile(outboundBytesPerSecond: 2000)!, target: target(1), revision: 2)
        XCTAssertEqual(shaper.status().first?.revision, 2)
        XCTAssertEqual(shaper.status().first?.outboundReleasedBytes, 0)
        XCTAssertEqual(shaper.status().first?.pausedFlows, 1)
        _ = shaper.resume(token)
        let status = shaper.status()
        XCTAssertEqual(try JSONDecoder().decode([ShapingStatus].self, from: JSONEncoder().encode(status)), status)
    }

    func testNewFlowPeekUsesSmallestShapedQuantum() {
        source.install(ShapingProfile(outboundBytesPerSecond: 2000, inboundBytesPerSecond: 1000)!)
        XCTAssertEqual(
            shaper.newFlow(flow(), target: RuleFixtures.target, transport: .stream),
            .filter(inbound: true, outbound: true, peekBytes: 100)
        )
        XCTAssertEqual(
            shaper.data(flow(), direction: .outbound, availableBytes: 500),
            .pass(bytes: 200, peekBytes: 200)
        )
        XCTAssertEqual(shaper.data(flow(), direction: .inbound, availableBytes: 500), .pass(bytes: 100, peekBytes: 100))
    }

    func testMaximumQuantumIsClampedToOneMebibyte() {
        source.install(ShapingProfile(outboundBytesPerSecond: 125_000_000)!)
        XCTAssertEqual(
            shaper.newFlow(flow(), target: RuleFixtures.target, transport: .stream),
            .filter(inbound: false, outbound: true, peekBytes: 1_048_576)
        )
        XCTAssertEqual(
            shaper.data(flow(), direction: .outbound, availableBytes: Int.max),
            .pass(bytes: 1_048_576, peekBytes: 1_048_576)
        )
        let token = pause(shaper.data(flow(), direction: .outbound, availableBytes: Int.max))
        XCTAssertEqual(token.resumeAtNanoseconds - clock.nanoseconds, 8_388_608)
    }

    func testFullWidthDurationDoesNotOverflowIntermediateProduct() {
        source.install(ShapingProfile(outboundBytesPerSecond: 125_000_000)!)
        _ = shaper.newFlow(flow(), target: RuleFixtures.target, transport: .datagram)
        // Multiplication needs more than 64 bits; this duration is 800s, over budget.
        XCTAssertEqual(shaper.data(flow(), direction: .outbound, availableBytes: 100_000_000_000), .drop)
        XCTAssertEqual(shaper.status().first?.outboundReleasedBytes, 0)
        XCTAssertEqual(shaper.status().first?.overBudgetDrops, 1)
        _ = shaper.newFlow(flow(1), target: RuleFixtures.target, transport: .datagram)
        XCTAssertEqual(
            shaper.data(flow(1), direction: .outbound, availableBytes: 1),
            .pass(bytes: 1, peekBytes: 1_048_576)
        )
        let token = pause(shaper.data(flow(1), direction: .outbound, availableBytes: 1))
        XCTAssertEqual(token.resumeAtNanoseconds, clock.nanoseconds + 8)
    }

    func testUnrepresentableDurationDropsWithoutChargeOrEarlyGrant() {
        source.install(ShapingProfile(outboundBytesPerSecond: 1000)!)
        admit(transport: .datagram)
        XCTAssertEqual(shaper.data(flow(), direction: .outbound, availableBytes: Int.max), .drop)
        XCTAssertEqual(shaper.data(flow(), direction: .outbound, availableBytes: 1), .allow)
        admit(1, transport: .datagram)
        XCTAssertEqual(
            shaper.data(flow(1), direction: .outbound, availableBytes: 1),
            .pass(bytes: 1, peekBytes: 100)
        )
        let token = pause(shaper.data(flow(1), direction: .outbound, availableBytes: 1))
        XCTAssertEqual(token.resumeAtNanoseconds, clock.nanoseconds + 1_000_000)
        clock.nanoseconds = UInt64.max
        XCTAssertEqual(shaper.resume(token), .settled(.pass(bytes: 1, peekBytes: 100)))
        XCTAssertEqual(shaper.data(flow(1), direction: .outbound, availableBytes: 1), .drop)
        XCTAssertEqual(shaper.status().first?.overBudgetDrops, 2)
    }

    func testUnrepresentableDelayDeadlineDropsWithoutPause() {
        source.install(ShapingProfile(outboundDelayMilliseconds: 1)!)
        clock.nanoseconds = UInt64.max - 1
        XCTAssertEqual(shaper.newFlow(flow(), target: RuleFixtures.target, transport: .stream), .drop)
        _ = shaper.newFlow(flow(1), target: RuleFixtures.target, transport: .datagram)
        XCTAssertEqual(shaper.data(flow(1), direction: .outbound, availableBytes: 1), .drop)
        XCTAssertEqual(shaper.status().first?.pausedFlows, 0)
        XCTAssertEqual(shaper.status().first?.overBudgetDrops, 2)
    }

    func testForeignPauseCannotConsumeRealPause() {
        let token = reservedData()
        let foreign = FlowPause(
            flow: token.flow,
            id: token.id,
            resumeAtNanoseconds: token.resumeAtNanoseconds,
            phase: .data(.inbound)
        )
        clock.nanoseconds = token.resumeAtNanoseconds
        XCTAssertEqual(shaper.resume(foreign), .alreadySettled)
        XCTAssertEqual(shaper.resume(token), .settled(.pass(bytes: 200, peekBytes: 200)))
    }

    func testPauseIDsNeverRepeatAfterRemoveAll() {
        let first = reservedData()
        _ = shaper.removeAll()
        let second = reservedData()
        XCTAssertGreaterThan(second.id, first.id)
        XCTAssertEqual(shaper.resume(first), .alreadySettled)
    }

    func testCallbackDuringNewFlowPauseKeepsConnectionToken() {
        source.install(ShapingProfile(outboundDelayMilliseconds: 10, outboundBytesPerSecond: 1000)!)
        guard case let .pause(token) = shaper.newFlow(flow(), target: RuleFixtures.target, transport: .stream) else {
            return XCTFail("Expected connection hold")
        }
        XCTAssertEqual(
            shaper.data(flow(), direction: .outbound, availableBytes: 500),
            .pass(bytes: 100, peekBytes: 100)
        )
        clock.nanoseconds = token.resumeAtNanoseconds
        XCTAssertEqual(shaper.resume(token), .settled(.filter(inbound: false, outbound: true, peekBytes: 100)))
        XCTAssertEqual(shaper.status().first?.callbacksWhilePaused, 1)
        XCTAssertEqual(shaper.status().first?.debtReleases, 1)
    }

    func testRefusalDiagnosticHistoryIsBounded() {
        for index in 0 ..< 200 {
            source.install(ShapingProfile(outboundBytesPerSecond: 1000)!, target: target(index))
            _ = shaper.newFlow(flow(index), target: target(index), transport: .stream)
        }
        XCTAssertEqual(shaper.status().count, FlowShaper.maximumTimelines + FlowShaper.maximumRefusedTargets)
        XCTAssertNil(shaper.status().first { $0.target == target(64) })
        XCTAssertEqual(shaper.status().first { $0.target == target(199) }?.refusedFlows, 1)
    }

    func testRefusedCountMigratesWhenTargetIsAdmitted() {
        for index in 0 ..< 65 {
            source.install(ShapingProfile(outboundBytesPerSecond: 1000)!, target: target(index))
            _ = shaper.newFlow(flow(index), target: target(index), transport: .stream)
        }
        source.rules.removeValue(forKey: target(0))
        _ = shaper.newFlow(flow(64), target: target(64), transport: .stream)
        let status = shaper.status().filter { $0.target == target(64) }
        XCTAssertEqual(status.count, 1)
        XCTAssertEqual(status.first?.refusedFlows, 1)
        XCTAssertEqual(status.first?.trackedFlows, 1)
    }

    func testStaleSweepKeepsReplacementPauseForCurrentRuleSettlement() {
        let token = reservedData()
        source.install(ShapingProfile(outboundBytesPerSecond: 1000)!, revision: 2)
        XCTAssertEqual(shaper.settleStale(), [])
        XCTAssertEqual(shaper.resume(token), .settled(.pass(bytes: 100, peekBytes: 100)))
    }

    func testNewFlowPrunesGoneRuleEvenWhenOldFlowIsPaused() {
        for index in 0 ..< 64 {
            source.install(ShapingProfile(outboundDelayMilliseconds: 10)!, target: target(index))
            _ = shaper.newFlow(flow(index), target: target(index), transport: .stream)
        }
        source.rules.removeValue(forKey: target(0))
        source.install(ShapingProfile(outboundBytesPerSecond: 1000)!, target: target(64))
        XCTAssertEqual(
            shaper.newFlow(flow(64), target: target(64), transport: .stream),
            .filter(inbound: false, outbound: true, peekBytes: 100)
        )
        XCTAssertEqual(shaper.settleStale().count, 1)
    }
}
