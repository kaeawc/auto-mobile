import Dispatch
import Foundation

public protocol PauseScheduler {
    /// Enqueue once, never on the caller's stack, no earlier than this deadline
    /// on the injected MonotonicClock's timeline.
    func schedule(atNanoseconds deadline: UInt64, _ work: @escaping () -> Void)
}

/// Wall deadlines count sleep, like CLOCK_MONOTONIC on macOS. A wall-clock step
/// may wake early or late: resume's notDue check and the one-second tick absorb
/// that skew. No rule decision relies on the wall clock itself.
public final class DispatchPauseScheduler: PauseScheduler {
    private let clock: MonotonicClock
    private let queue = DispatchQueue(label: "AutoMobile.FlowShaping")

    public init(clock: MonotonicClock) { self.clock = clock }

    public func schedule(atNanoseconds deadline: UInt64, _ work: @escaping () -> Void) {
        let now = clock.nowNanoseconds()
        let delay = deadline > now ? deadline - now : 0
        queue.asyncAfter(wallDeadline: .now() + Double(delay) / 1_000_000_000) { [self] in
            // Protect even minimum-age handler delivery from a forward wall step.
            if clock.nowNanoseconds() < deadline { schedule(atNanoseconds: deadline, work) }
            else { work() }
        }
    }
}

public enum ShapedFlowVerdict: Equatable {
    case allow
    case filter(inbound: Bool, outbound: Bool, peekBytes: Int)
    case pass(bytes: Int, peekBytes: Int)
    case pause
    case drop
}

public enum FlowResumeVerdict: Equatable {
    case allow
    case filter(inbound: Bool, outbound: Bool, peekBytes: Int)
    case pass(bytes: Int, peekBytes: Int)
    case drop
}

public struct ShapingActivity: Codable, Equatable {
    public let flows: [ShapingStatus]
    public let untrackedDataCallbacks: UInt64
    public let pendingPauses: Int
    public let filteredFlows: Int
    public let completionRecords: Int
    public let tickOutstanding: Bool
    public let orphanedPauses: UInt64
    public let unexpectedSecondPause: UInt64
}

/// Owns tokens and handlers, never payloads. Lock order is coordinator → shaper
/// → rule source. Claiming a handler under this lock makes every exit exactly
/// once; scheduling and delivery happen only after unlocking. Delayed work is
/// fenced by the shaper's non-repeating token IDs and the tick's identity.
public final class FlowShapingCoordinator {
    public static let minimumPauseAgeNanoseconds: UInt64 = 10_000_000
    public static let tickIntervalNanoseconds: UInt64 = 1_000_000_000

    private struct Pending {
        let token: FlowPause
        let pausedAt: UInt64
        let handler: (FlowResumeVerdict) -> Void
    }

    private struct Directions {
        let inbound: Bool
        let outbound: Bool
    }

    private struct Work {
        let deadline: UInt64
        let run: () -> Void
    }

    private let shaper: FlowShaper
    private let clock: MonotonicClock
    private let scheduler: PauseScheduler
    private let lock = NSLock()
    private var lastNow: UInt64 = 0
    private var pending: [UUID: Pending] = [:]
    private var filtered: [UUID: Directions] = [:]
    private var filteredOrder: [UUID] = []
    private var completed: [UUID: FlowDirection] = [:]
    private var completedOrder: [UUID] = []
    private var tick: UUID?
    private var orphanedPauses: UInt64 = 0
    private var unexpectedSecondPause: UInt64 = 0

    public init(shaper: FlowShaper, clock: MonotonicClock, scheduler: PauseScheduler) {
        self.shaper = shaper
        self.clock = clock
        self.scheduler = scheduler
    }

    public func newFlow(
        _ flow: UUID, target: NetworkRuleTarget, transport: FlowTransport,
        onResume: @escaping (FlowResumeVerdict) -> Void
    )
        -> ShapedFlowVerdict
    {
        lock.lock()
        var work: [Work] = []
        let verdict: ShapedFlowVerdict
        switch shaper.newFlow(flow, target: target, transport: transport) {
        case .allow:
            forgetRecords(flow)
            verdict = .allow
        case let .filter(inbound, outbound, peek):
            recordFilter(flow, inbound: inbound, outbound: outbound)
            verdict = .filter(inbound: inbound, outbound: outbound, peekBytes: peek)
        case let .pause(token): verdict = register(token, handler: onResume, work: &work)
        case .drop:
            claim(flow, verdict: .drop, work: &work)
            forgetRecords(flow)
            verdict = .drop
        }
        unlockAndSchedule(work)
        return verdict
    }

    public func data(
        _ flow: UUID, direction: FlowDirection, availableBytes: Int,
        onResume: @escaping (FlowResumeVerdict) -> Void
    )
        -> ShapedFlowVerdict
    {
        lock.lock()
        var work: [Work] = []
        let verdict: ShapedFlowVerdict
        switch shaper.data(flow, direction: direction, availableBytes: availableBytes) {
        case .allow:
            forgetRecords(flow)
            verdict = .allow
        case let .pass(bytes, peek): verdict = .pass(bytes: bytes, peekBytes: peek)
        case let .pause(token): verdict = register(token, handler: onResume, work: &work)
        case .drop:
            claim(flow, verdict: .drop, work: &work)
            forgetRecords(flow)
            verdict = .drop
        }
        unlockAndSchedule(work)
        return verdict
    }

    public func dataComplete(_ flow: UUID, direction: FlowDirection) {
        lock.lock()
        var work: [Work] = []
        let directions = filtered[flow]
        let singleDirection = directions.map {
            direction == .inbound ? $0.inbound && !$0.outbound : $0.outbound && !$0.inbound
        } ?? false
        if singleDirection || completed[flow].map({ $0 != direction }) == true {
            if let settlement = shaper.flowEnded(flow) { settle(settlement, work: &work) }
            // Also cover a token the shaper already forgot.
            claim(flow, verdict: .allow, work: &work)
            forgetRecords(flow)
        } else if completed[flow] == nil {
            completed[flow] = direction
            completedOrder.append(flow)
            if completedOrder.count > FlowShaper.maximumFlows {
                completed.removeValue(forKey: completedOrder.removeFirst())
            }
        }
        unlockAndSchedule(work)
    }

    public func rulesChanged() {
        lock.lock()
        var work: [Work] = []
        sweep(work: &work, recheckAll: true)
        unlockAndSchedule(work)
    }

    public func stop() {
        lock.lock()
        var work: [Work] = []
        _ = shaper.removeAll()
        for flow in Array(pending.keys) {
            claim(flow, verdict: .allow, work: &work)
        }
        filtered.removeAll()
        filteredOrder.removeAll()
        completed.removeAll()
        completedOrder.removeAll()
        tick = nil
        orphanedPauses = 0
        unexpectedSecondPause = 0
        unlockAndSchedule(work)
    }

    public func status() -> ShapingActivity {
        lock.lock()
        defer { lock.unlock() }
        return ShapingActivity(
            flows: shaper.status(), untrackedDataCallbacks: shaper.untrackedDataCallbacks,
            pendingPauses: pending.count, filteredFlows: filtered.count, completionRecords: completed.count,
            tickOutstanding: tick != nil, orphanedPauses: orphanedPauses,
            unexpectedSecondPause: unexpectedSecondPause
        )
    }

    // MARK: - Decisions and bounded records (lock held)

    private func register(
        _ token: FlowPause, handler: @escaping (FlowResumeVerdict) -> Void, work: inout [Work]
    )
        -> ShapedFlowVerdict
    {
        guard pending[token.flow] == nil else {
            unexpectedSecondPause = Self.add(unexpectedSecondPause, 1)
            return .allow
        }
        pending[token.flow] = Pending(token: token, pausedAt: now(), handler: handler)
        work.append(timerWork(token, at: token.resumeAtNanoseconds))
        ensureTick(work: &work)
        return .pause
    }

    private func claim(_ flow: UUID, verdict: FlowResumeVerdict, work: inout [Work]) {
        guard let pause = pending.removeValue(forKey: flow) else { return }
        switch verdict {
        case let .filter(inbound, outbound, _): recordFilter(flow, inbound: inbound, outbound: outbound)
        case .allow, .drop: forgetRecords(flow)
        case .pass: break
        }
        let deadline = max(now(), Self.add(pause.pausedAt, Self.minimumPauseAgeNanoseconds))
        work.append(Work(deadline: deadline, run: { pause.handler(verdict) }))
    }

    private func settle(_ settlement: FlowSettlement, work: inout [Work]) {
        guard pending[settlement.pause.flow]?.token == settlement.pause else { return }
        claim(settlement.pause.flow, verdict: Self.map(settlement.decision), work: &work)
    }

    private func resume(_ token: FlowPause, work: inout [Work], rescheduleEarly: Bool) {
        guard pending[token.flow]?.token == token else { return }
        switch shaper.resume(token) {
        case let .settled(decision): claim(token.flow, verdict: Self.map(decision), work: &work)
        case .alreadySettled:
            orphanedPauses = Self.add(orphanedPauses, 1)
            claim(token.flow, verdict: .allow, work: &work)
        case let .notDue(deadline):
            if rescheduleEarly { work.append(timerWork(token, at: deadline)) }
        }
    }

    private func sweep(work: inout [Work], recheckAll: Bool) {
        for settlement in shaper.settleStale() {
            settle(settlement, work: &work)
        }
        let current = now()
        for pause in pending.values.sorted(by: { $0.token.id < $1.token.id })
            where recheckAll || pause.token.resumeAtNanoseconds <= current
        {
            resume(pause.token, work: &work, rescheduleEarly: false)
        }
    }

    private func recordFilter(_ flow: UUID, inbound: Bool, outbound: Bool) {
        if filtered[flow] == nil { filteredOrder.append(flow) }
        filtered[flow] = Directions(inbound: inbound, outbound: outbound)
        if filteredOrder.count > FlowShaper.maximumFlows {
            filtered.removeValue(forKey: filteredOrder.removeFirst())
        }
    }

    private func forgetRecords(_ flow: UUID) {
        filtered.removeValue(forKey: flow)
        filteredOrder.removeAll { $0 == flow }
        completed.removeValue(forKey: flow)
        completedOrder.removeAll { $0 == flow }
    }

    private func now() -> UInt64 {
        lastNow = max(lastNow, clock.nowNanoseconds())
        return lastNow
    }

    private static func map(_ decision: ResumeDecision) -> FlowResumeVerdict {
        switch decision {
        case .allow: .allow
        case let .filter(inbound, outbound, peek): .filter(inbound: inbound, outbound: outbound, peekBytes: peek)
        case let .pass(bytes, peek): .pass(bytes: bytes, peekBytes: peek)
        }
    }

    private static func add(_ lhs: UInt64, _ rhs: UInt64) -> UInt64 {
        let value = lhs.addingReportingOverflow(rhs)
        return value.overflow ? .max : value.partialValue
    }

    // MARK: - Timers (all external work runs after unlocking)

    private func timerWork(_ token: FlowPause, at deadline: UInt64) -> Work {
        Work(deadline: deadline, run: { [weak self] in self?.timerFired(token) })
    }

    private func timerFired(_ token: FlowPause) {
        lock.lock()
        var work: [Work] = []
        resume(token, work: &work, rescheduleEarly: true)
        unlockAndSchedule(work)
    }

    private func ensureTick(work: inout [Work]) {
        guard tick == nil, !pending.isEmpty else { return }
        let identity = UUID()
        tick = identity
        work.append(Work(deadline: Self.add(now(), Self.tickIntervalNanoseconds), run: { [weak self] in
            self?.tickFired(identity)
        }))
    }

    private func tickFired(_ identity: UUID) {
        lock.lock()
        var work: [Work] = []
        if tick == identity {
            tick = nil
            sweep(work: &work, recheckAll: false)
            ensureTick(work: &work)
        }
        unlockAndSchedule(work)
    }

    private func unlockAndSchedule(_ work: [Work]) {
        lock.unlock()
        for item in work {
            scheduler.schedule(atNanoseconds: item.deadline, item.run)
        }
    }
}
