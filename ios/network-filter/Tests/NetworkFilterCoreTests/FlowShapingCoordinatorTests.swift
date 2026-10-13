// swiftlint:disable force_unwrapping
import Foundation
@testable import NetworkFilterCore
import XCTest

/// Work is only run explicitly, and can be replayed to model duplicate timers.
final class FakePauseScheduler: PauseScheduler {
    struct Item {
        let deadline: UInt64
        let work: () -> Void
    }

    private let lock = NSLock()
    private var queue: [Item] = []
    private var scheduleHook: (() -> Void)?
    var onSchedule: (() -> Void)? {
        get {
            lock.lock()
            defer { lock.unlock() }
            return scheduleHook
        }
        set {
            lock.lock()
            scheduleHook = newValue
            lock.unlock()
        }
    }

    var items: [Item] {
        lock.lock()
        defer { lock.unlock() }
        return queue
    }

    func schedule(atNanoseconds deadline: UInt64, _ work: @escaping () -> Void) {
        lock.lock()
        queue.append(Item(deadline: deadline, work: work))
        lock.unlock()
        onSchedule?()
    }

    func runDue(_ clock: MonotonicClock) {
        while true {
            lock.lock()
            guard let index = queue.firstIndex(where: { $0.deadline <= clock.nowNanoseconds() }) else {
                lock.unlock()
                return
            }
            let item = queue.remove(at: index)
            lock.unlock()
            item.work()
        }
    }
}

final class RecordingResume {
    private let lock = NSLock()
    private var recorded: [FlowResumeVerdict] = []
    var verdicts: [FlowResumeVerdict] {
        lock.lock()
        defer { lock.unlock() }
        return recorded
    }

    func receive(_ verdict: FlowResumeVerdict) {
        lock.lock()
        recorded.append(verdict)
        lock.unlock()
    }
}

final class FlowShapingCoordinatorTests: XCTestCase {
    private var clock = FakeMonotonicClock()
    private var source = FakeShapingRuleSource()
    private var scheduler = FakePauseScheduler()
    private var coordinator: FlowShapingCoordinator!
    private var handler = RecordingResume()
    private let flow = UUID()

    override func setUp() {
        super.setUp()
        clock = FakeMonotonicClock()
        source = FakeShapingRuleSource()
        scheduler = FakePauseScheduler()
        handler = RecordingResume()
        coordinator = FlowShapingCoordinator(
            shaper: FlowShaper(clock: clock, ruleSource: source), clock: clock, scheduler: scheduler
        )
    }

    private func install(_ profile: ShapingProfile, revision: UInt64 = 1) {
        source.install(profile, revision: revision)
    }

    @discardableResult
    private func admit(_ id: UUID? = nil, transport: FlowTransport = .stream) -> ShapedFlowVerdict {
        coordinator.newFlow(id ?? flow, target: RuleFixtures.target, transport: transport, onResume: handler.receive)
    }

    @discardableResult
    private func data(_ bytes: Int = 500) -> ShapedFlowVerdict {
        coordinator.data(flow, direction: .outbound, availableBytes: bytes, onResume: handler.receive)
    }

    private func advance(_ milliseconds: UInt64) {
        clock.advance(milliseconds: milliseconds)
        scheduler.runDue(clock)
    }

    private func pausedData() {
        install(ShapingProfile(outboundDelayMilliseconds: 100, outboundBytesPerSecond: 2000)!)
        XCTAssertEqual(admit(transport: .datagram), .filter(inbound: false, outbound: true, peekBytes: 200))
        XCTAssertEqual(data(200), .pause)
        XCTAssertEqual(handler.verdicts, [])
    }

    func testScheduledWorkClaimRejectsEarlyWakesAndClaimsOnlyOnce() {
        let claim = ScheduledWorkClaim(deadline: 100)
        XCTAssertEqual(claim.claim(atNanoseconds: 99), .early)
        XCTAssertEqual(claim.claim(atNanoseconds: 0), .early)
        XCTAssertEqual(claim.claim(atNanoseconds: 100), .run)
        XCTAssertEqual(claim.claim(atNanoseconds: 101), .finished)
        XCTAssertEqual(claim.claim(atNanoseconds: 0), .finished)
    }

    func testScheduledWorkClaimIsThreadSafe() {
        for _ in 0 ..< 30 {
            let claim = ScheduledWorkClaim(deadline: 100)
            let winner = RecordingResume()
            DispatchQueue.concurrentPerform(iterations: 24) { index in
                if claim.claim(atNanoseconds: index.isMultiple(of: 2) ? 99 : 100) == .run {
                    winner.receive(.allow)
                }
            }
            XCTAssertEqual(winner.verdicts, [.allow])
            XCTAssertEqual(claim.claim(atNanoseconds: 100), .finished)
        }
    }

    func testNonPauseVerdictsReleaseHandlersWithoutDelivery() {
        XCTAssertEqual(admit(), .allow)
        XCTAssertEqual(data(), .allow)
        install(ShapingProfile(outboundBytesPerSecond: 1000)!)
        XCTAssertEqual(admit(), .filter(inbound: false, outbound: true, peekBytes: 100))
        XCTAssertEqual(data(), .pass(bytes: 100, peekBytes: 100))
        coordinator.dataComplete(flow, direction: .outbound)
        install(ShapingProfile(outboundBytesPerSecond: 1000)!)
        XCTAssertEqual(admit(transport: .datagram), .filter(inbound: false, outbound: true, peekBytes: 100))
        XCTAssertEqual(data(9000), .drop)
        advance(1000)
        XCTAssertEqual(handler.verdicts, [])
    }

    func testSchedulingAndDeliveryNeverHoldCoordinatorLock() {
        scheduler.onSchedule = { [coordinator] in _ = coordinator?.status() }
        install(ShapingProfile(outboundDelayMilliseconds: 100)!)
        let recorder = RecordingResume()
        let resume: (FlowResumeVerdict) -> Void = { [coordinator] verdict in
            _ = coordinator?.status()
            recorder.receive(verdict)
        }
        XCTAssertEqual(
            coordinator.newFlow(flow, target: RuleFixtures.target, transport: .stream, onResume: resume), .pause
        )
        coordinator.stop()
        XCTAssertEqual(recorder.verdicts, [])
        advance(10)
        XCTAssertEqual(recorder.verdicts, [.allow])
    }

    func testOrphanedPauseAllowsOnceAndCountsDiagnostic() {
        let shaper = FlowShaper(clock: clock, ruleSource: source)
        coordinator = FlowShapingCoordinator(shaper: shaper, clock: clock, scheduler: scheduler)
        pausedData()
        // Simulate the shaper losing a token; production only calls it through
        // the coordinator. The adapter must release its retained handler.
        _ = shaper.removeAll()
        advance(100)
        XCTAssertEqual(handler.verdicts, [.allow])
        XCTAssertEqual(coordinator.status().orphanedPauses, 1)
        advance(1000)
        XCTAssertEqual(handler.verdicts, [.allow])
    }

    func testNewFlowTimerDeliversFilterOnce() {
        install(ShapingProfile(outboundDelayMilliseconds: 100)!)
        XCTAssertEqual(admit(), .pause)
        let timer = scheduler.items[0]
        advance(100)
        timer.work()
        scheduler.runDue(clock)
        XCTAssertEqual(handler.verdicts, [.filter(inbound: false, outbound: true, peekBytes: 65536)])
    }

    func testDataTimerDeliversPassOnce() {
        pausedData()
        let timer = scheduler.items[0]
        advance(100)
        timer.work()
        scheduler.runDue(clock)
        XCTAssertEqual(handler.verdicts, [.pass(bytes: 200, peekBytes: 200)])
    }

    func testEarlyTimerReschedulesAndDuplicateFiringsCannotDeliverTwice() {
        pausedData()
        let timer = scheduler.items[0]
        timer.work()
        XCTAssertEqual(handler.verdicts, [])
        XCTAssertEqual(scheduler.items.filter { $0.deadline == timer.deadline }.count, 2)
        advance(100)
        timer.work()
        scheduler.runDue(clock)
        XCTAssertEqual(handler.verdicts.count, 1)
    }

    func testNewFlowMinimumPauseAgeAndAsynchronousDelivery() {
        install(ShapingProfile(outboundDelayMilliseconds: 1)!)
        XCTAssertEqual(admit(), .pause)
        advance(1)
        XCTAssertEqual(handler.verdicts, [])
        advance(8)
        XCTAssertEqual(handler.verdicts, [])
        advance(1)
        XCTAssertEqual(handler.verdicts.count, 1)
    }

    func testDataMinimumPauseAgeAndAsynchronousDelivery() {
        install(ShapingProfile(outboundDelayMilliseconds: 1)!)
        _ = admit(transport: .datagram)
        XCTAssertEqual(data(), .pause)
        advance(1)
        XCTAssertEqual(handler.verdicts, [])
        advance(9)
        XCTAssertEqual(handler.verdicts, [.pass(bytes: 500, peekBytes: 65536)])
    }

    func testResetBeforeTimerDeliversAllowOnceOutsideRulesChanged() {
        pausedData()
        source.rules.removeAll()
        coordinator.rulesChanged()
        XCTAssertEqual(handler.verdicts, [])
        advance(9)
        XCTAssertEqual(handler.verdicts, [])
        advance(1)
        XCTAssertEqual(handler.verdicts, [.allow])
        advance(1000)
        XCTAssertEqual(handler.verdicts, [.allow])
    }

    func testTimerBeforeResetKeepsItsSingleDecision() {
        pausedData()
        advance(100)
        source.rules.removeAll()
        coordinator.rulesChanged()
        advance(1000)
        XCTAssertEqual(handler.verdicts, [.pass(bytes: 200, peekBytes: 200)])
    }

    func testFlowEndBeforeTimerAllowsOnce() {
        install(ShapingProfile(outboundDelayMilliseconds: 100, inboundDelayMilliseconds: 100)!)
        XCTAssertEqual(admit(), .pause)
        coordinator.dataComplete(flow, direction: .inbound)
        XCTAssertEqual(coordinator.status().pendingPauses, 1)
        coordinator.dataComplete(flow, direction: .outbound)
        XCTAssertEqual(handler.verdicts, [])
        advance(10)
        XCTAssertEqual(handler.verdicts, [.allow])
        advance(2000)
        XCTAssertEqual(handler.verdicts, [.allow])
    }

    func testTimerBeforeFlowEndKeepsItsSingleDecision() {
        pausedData()
        advance(100)
        coordinator.dataComplete(flow, direction: .inbound)
        coordinator.dataComplete(flow, direction: .outbound)
        advance(1000)
        XCTAssertEqual(handler.verdicts, [.pass(bytes: 200, peekBytes: 200)])
    }

    func testStopSettlesEveryPauseAndOldTimersCannotMatchReusedFlow() {
        pausedData()
        let old = scheduler.items
        coordinator.stop()
        XCTAssertEqual(handler.verdicts, [])
        XCTAssertEqual(coordinator.status().pendingPauses, 0)
        XCTAssertEqual(admit(), .pause)
        for item in old {
            item.work()
        }
        advance(10)
        XCTAssertEqual(handler.verdicts, [.allow])
        advance(90)
        XCTAssertEqual(handler.verdicts, [.allow, .filter(inbound: false, outbound: true, peekBytes: 200)])
        advance(1000)
        XCTAssertEqual(handler.verdicts.count, 2)
    }

    func testDatagramReplacementSettlesWholeGrantAgainstCurrentRevisionAsDebt() {
        pausedData()
        install(ShapingProfile(outboundBytesPerSecond: 1000)!, revision: 2)
        coordinator.rulesChanged()
        advance(10)
        XCTAssertEqual(handler.verdicts, [.pass(bytes: 200, peekBytes: 100)])
        XCTAssertEqual(coordinator.status().flows.first?.debtReleases, 1)
        advance(1000)
        XCTAssertEqual(handler.verdicts.count, 1)
    }

    func testStreamReplacementReclampsDebtToCurrentQuantum() {
        install(ShapingProfile(outboundBytesPerSecond: 2000)!)
        XCTAssertEqual(admit(), .filter(inbound: false, outbound: true, peekBytes: 200))
        XCTAssertEqual(data(200), .pass(bytes: 200, peekBytes: 200))
        XCTAssertEqual(data(200), .pause)
        install(ShapingProfile(outboundBytesPerSecond: 1000)!, revision: 2)
        coordinator.rulesChanged()
        XCTAssertEqual(handler.verdicts, [])
        advance(10)
        XCTAssertEqual(handler.verdicts, [.pass(bytes: 100, peekBytes: 100)])
        XCTAssertEqual(coordinator.status().flows.first?.debtReleases, 1)
        advance(1000)
        XCTAssertEqual(handler.verdicts.count, 1)
    }

    func testOfflineReplacementAllowsOnce() {
        useStore(lease: 15000)
        XCTAssertEqual(admit(), .pause)
        XCTAssertEqual(store?.execute(RuleFixtures.apply(RuleFixtures.ownership(revision: 2))).outcome, .applied)
        coordinator.rulesChanged()
        advance(10)
        XCTAssertEqual(handler.verdicts, [.allow])
        advance(1000)
        XCTAssertEqual(handler.verdicts, [.allow])
    }

    func testLaterDebtCallbackKeepsPauseAndSecondCallbackDropsHandlerOnce() {
        pausedData()
        XCTAssertEqual(data(200), .pass(bytes: 200, peekBytes: 200))
        XCTAssertEqual(coordinator.status().pendingPauses, 1)
        XCTAssertEqual(data(200), .drop)
        XCTAssertEqual(handler.verdicts, [])
        advance(10)
        XCTAssertEqual(handler.verdicts, [.drop])
        advance(1000)
        XCTAssertEqual(handler.verdicts, [.drop])
    }

    func testAllowLatchKeepsPauseUntilStaleSettlement() {
        pausedData()
        source.rules.removeAll()
        XCTAssertEqual(data(), .allow)
        XCTAssertEqual(coordinator.status().pendingPauses, 1)
        coordinator.rulesChanged()
        advance(10)
        XCTAssertEqual(handler.verdicts, [.allow])
        advance(1000)
        XCTAssertEqual(handler.verdicts, [.allow])
    }

    func testUnexpectedSecondPauseKeepsFirstHandler() {
        install(ShapingProfile(outboundDelayMilliseconds: 100)!)
        XCTAssertEqual(admit(), .pause)
        XCTAssertEqual(admit(), .allow)
        XCTAssertEqual(coordinator.status().unexpectedSecondPause, 1)
        advance(100)
        XCTAssertEqual(handler.verdicts.count, 1)
    }

    func testTickResumesLostTimerStopsAndRestarts() {
        pausedData()
        let tick = scheduler.items[1]
        clock.advance(milliseconds: 1000)
        tick.work()
        XCTAssertEqual(handler.verdicts, [])
        scheduler.runDue(clock)
        XCTAssertEqual(handler.verdicts.count, 1)
        XCTAssertFalse(coordinator.status().tickOutstanding)
        _ = admit(UUID(), transport: .stream)
        XCTAssertTrue(coordinator.status().tickOutstanding)
        XCTAssertEqual(coordinator.status().pendingPauses, 1)
        coordinator.stop()
        advance(10)
        XCTAssertEqual(handler.verdicts.count, 2)
    }

    func testExactlyOneTickWhileMultiplePausesArePending() {
        install(ShapingProfile(outboundDelayMilliseconds: 1500, inboundDelayMilliseconds: 1500)!)
        for _ in 0 ..< 4 {
            XCTAssertEqual(admit(UUID()), .pause)
        }
        XCTAssertEqual(scheduler.items.filter { $0.deadline == clock.nanoseconds + 1_000_000_000 }.count, 1)
        advance(1000)
        XCTAssertEqual(scheduler.items.filter { $0.deadline == clock.nanoseconds + 1_000_000_000 }.count, 1)
        coordinator.stop()
        advance(10)
        XCTAssertEqual(handler.verdicts, Array(repeating: .allow, count: 4))
    }

    func testSingleDirectionCompletionEndsFlow() {
        pausedData()
        coordinator.dataComplete(flow, direction: .outbound)
        advance(10)
        XCTAssertEqual(handler.verdicts, [.allow])
        XCTAssertEqual(coordinator.status().flows.first?.trackedFlows, 0)
        XCTAssertEqual(coordinator.status().filteredFlows, 0)
    }

    func testBothDirectionCompletionNeedsBothAndIgnoresDuplicates() {
        install(ShapingProfile(outboundBytesPerSecond: 1000, inboundBytesPerSecond: 1000)!)
        _ = admit()
        coordinator.dataComplete(flow, direction: .outbound)
        coordinator.dataComplete(flow, direction: .outbound)
        XCTAssertEqual(coordinator.status().flows.first?.trackedFlows, 1)
        coordinator.dataComplete(flow, direction: .inbound)
        XCTAssertEqual(coordinator.status().flows.first?.trackedFlows, 0)
        XCTAssertEqual(handler.verdicts, [])
    }

    func testCompletionTablesAreBoundedAndForgetOldest() {
        install(ShapingProfile(outboundBytesPerSecond: 1000, inboundBytesPerSecond: 1000)!)
        _ = admit()
        coordinator.dataComplete(flow, direction: .inbound)
        for _ in 0 ..< 300 {
            coordinator.dataComplete(UUID(), direction: .inbound)
        }
        XCTAssertEqual(coordinator.status().completionRecords, 256)
        coordinator.dataComplete(flow, direction: .outbound)
        XCTAssertEqual(coordinator.status().flows.first?.trackedFlows, 1)
        coordinator.dataComplete(flow, direction: .inbound)
        XCTAssertEqual(coordinator.status().flows.first?.trackedFlows, 0)
        // Idle eviction replaces the shaper slot; adapter records stay capped.
        for _ in 0 ..< 300 {
            clock.advance(milliseconds: 60000)
            _ = admit(UUID())
        }
        XCTAssertEqual(coordinator.status().filteredFlows, 256)
        coordinator.stop()
        XCTAssertEqual(coordinator.status().completionRecords, 0)
        XCTAssertEqual(coordinator.status().filteredFlows, 0)
        XCTAssertEqual(handler.verdicts, [])
    }

    func testPendingPausesNeverExceedShaperCapacity() {
        install(ShapingProfile(outboundDelayMilliseconds: 100)!)
        for _ in 0 ..< FlowShaper.maximumFlows + 20 {
            _ = admit(UUID())
        }
        XCTAssertEqual(coordinator.status().pendingPauses, FlowShaper.maximumFlows)
        coordinator.stop()
        advance(10)
        XCTAssertEqual(handler.verdicts, Array(repeating: .allow, count: FlowShaper.maximumFlows))
    }

    private var store: NetworkRuleStore?
    private func useStore(lease: UInt64) {
        let rules = NetworkRuleStore(clock: clock, supportsShaping: true)
        store = rules
        XCTAssertEqual(rules.execute(NetworkRuleCommand(
            kind: .apply, target: RuleFixtures.target, ownership: RuleFixtures.ownership(revision: 1),
            condition: .shaped(ShapingRequest(delayMilliseconds: 2000)), leaseMilliseconds: lease
        )).outcome, .applied)
        coordinator = FlowShapingCoordinator(
            shaper: FlowShaper(clock: clock, ruleSource: rules), clock: clock, scheduler: scheduler
        )
    }

    func testRealStoreResetSettlesOnce() {
        useStore(lease: 15000)
        XCTAssertEqual(admit(), .pause)
        XCTAssertEqual(store?.execute(RuleFixtures.reset(RuleFixtures.ownership(revision: 2))).outcome, .reset)
        coordinator.rulesChanged()
        advance(10)
        XCTAssertEqual(handler.verdicts, [.allow])
        advance(5000)
        XCTAssertEqual(handler.verdicts, [.allow])
    }

    func testLeaseExpiryTickAloneSettlesWithinOneInterval() {
        useStore(lease: 1000)
        XCTAssertEqual(admit(), .pause)
        advance(1000)
        XCTAssertEqual(handler.verdicts, [.allow])
        advance(5000)
        XCTAssertEqual(handler.verdicts, [.allow])
    }

    private func raceSettlements(
        _ flows: [UUID], timers: [FakePauseScheduler.Item], rules: NetworkRuleStore,
        coordinator: FlowShapingCoordinator
    ) {
        let fireTimers = { for timer in timers {
            timer.work()
        } }
        let operations: [() -> Void] = [
            fireTimers, fireTimers,
            {
                _ = rules.execute(RuleFixtures.reset(RuleFixtures.ownership(revision: 2)))
                coordinator.rulesChanged()
            },
            { for flow in flows {
                coordinator.dataComplete(flow, direction: .inbound)
            } },
            { for flow in flows {
                coordinator.dataComplete(flow, direction: .outbound)
            } },
            {
                for flow in flows {
                    // Zero-byte callbacks exercise paused/allow-latched data
                    // without creating a fresh data pause after a due resume.
                    _ = coordinator.data(flow, direction: .outbound, availableBytes: 0) { _ in
                        XCTFail("A late callback must not register another pause")
                    }
                }
            },
            { [self] in scheduler.runDue(clock) },
            { for _ in flows {
                _ = coordinator.status()
            } },
        ]
        DispatchQueue.concurrentPerform(iterations: operations.count) { operations[$0]() }
    }

    func testConcurrentSettlementsDeliverEveryPauseExactlyOnce() {
        for _ in 0 ..< 30 {
            useStore(lease: 15000)
            let handlers = (0 ..< 24).map { _ in RecordingResume() }
            let flows = handlers.map { _ in UUID() }
            for index in handlers.indices {
                let transport: FlowTransport = index.isMultiple(of: 2) ? .stream : .datagram
                let verdict = coordinator.newFlow(
                    flows[index], target: RuleFixtures.target, transport: transport, onResume: handlers[index].receive
                )
                if transport == .stream {
                    XCTAssertEqual(verdict, .pause)
                } else {
                    XCTAssertEqual(verdict, .filter(inbound: true, outbound: true, peekBytes: 65536))
                    XCTAssertEqual(coordinator.data(
                        flows[index], direction: .outbound, availableBytes: 10, onResume: handlers[index].receive
                    ), .pause)
                }
            }
            let timers = scheduler.items
            // Datagram data timers and the tick are due; new-flow timers are
            // still early. All compete with reset/completion for the handlers.
            // Clock writes happen only before/after the concurrent reads.
            clock.advance(milliseconds: 1000)
            let current = coordinator!
            let rules = store!
            raceSettlements(flows, timers: timers, rules: rules, coordinator: current)
            // Pin actual concurrent settlement, before the serial stop can hide
            // a race that lost a pending handler.
            scheduler.runDue(clock)
            XCTAssertEqual(current.status().pendingPauses, 0)
            for recorder in handlers {
                XCTAssertEqual(recorder.verdicts.count, 1)
            }
            current.stop()
            scheduler.runDue(clock)
            XCTAssertEqual(current.status().pendingPauses, 0)
            for recorder in handlers {
                XCTAssertEqual(recorder.verdicts.count, 1)
            }
            scheduler = FakePauseScheduler()
        }
    }
}
