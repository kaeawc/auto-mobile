import Foundation

/// Pure, bounded scheduling; the caller supplies payloads, timers and verdict glue.
/// Lock order: shaper lock, then rule source; the source must never call back.
/// Time readings are clamped to the last reading, including after sleep.
///
/// Each target/direction has a FIFO reservation timeline, with no idle credit:
/// slot = max(now, nextFree), nextFree = slot + ceil(bytes * 1e9 / rate).
/// Release is max(now + burst hold, slot); charging before the hold lets another
/// flow use its own slot. In any T window, released bytes are bounded by
/// rate * (T + directional delay) + (1 + D) grants; from rule start by
/// rate * T + (1 + D) grants. D counts replacement/paused-callback debt releases,
/// each charged a full slot. With no debt there is exactly one grant of slack.
/// For variable datagrams, a grant in the bound means the largest grant size.
///
/// Burst holds apply per flow/direction on first data or after a quiet gap equal
/// to the smallest non-zero profile delay since its last arrival or release.
/// Streams also hold connection establishment for the sum of directional delays;
/// datagrams do not. Upload is app → remote, download is remote → app.
/// Stream grants use clamp(rate/10, 1...1048576); unlimited data and datagrams
/// pass whole. Directional peek windows use that quantum (65536 if unlimited).
///
/// State holds no payloads: at most 256 flows, one reservation/token per flow,
/// 64 timelines and 64 refused-only diagnostic entries. Admission evicts only
/// unpaused flows idle 60 seconds, oldest activity then UUID; otherwise refuses.
/// Pauses over 30 seconds for streams or 8 seconds for UDP drop without charge,
/// keeping UDP below Apple's ten-second limit. Caller-owned timers recheck the
/// rule ticket on resume; reset/end/stop settle with allow exactly once.
/// Same-ticket renewals preserve budgets; new tickets reset them and counters.
/// Positive callbacks during a pause pass one debt grant without replacing it;
/// non-positive callbacks pass zero without charge. Counter/time overflow
/// saturates, and exhausted timelines cannot wrap into early normal grants.
public final class FlowShaper {
    public static let maximumFlows = 256
    public static let maximumTimelines = NetworkRuleStore.maximumRules
    public static let maximumDatagramPauseNanoseconds: UInt64 = 8_000_000_000
    public static let maximumStreamPauseNanoseconds: UInt64 = 30_000_000_000
    public static let idleEvictionNanoseconds: UInt64 = 60_000_000_000
    /// Bounded diagnostic history for targets refused at timeline capacity.
    public static let maximumRefusedTargets = 64

    private struct Pending {
        let pause: FlowPause
        let ticket: NetworkRuleTicket
        let bytes: Int
    }

    private struct Flow {
        let target: NetworkRuleTarget
        let transport: FlowTransport
        var lastActive: UInt64
        var inboundActivity: UInt64?
        var outboundActivity: UInt64?
        var pending: Pending?

        func activity(_ direction: FlowDirection) -> UInt64? {
            direction == .inbound ? inboundActivity : outboundActivity
        }

        mutating func record(_ direction: FlowDirection, now: UInt64) {
            lastActive = now
            if direction == .inbound { inboundActivity = now } else { outboundActivity = now }
        }
    }

    private struct Timeline {
        let rule: ShapingRule
        var inboundNext: UInt64 = 0
        var outboundNext: UInt64 = 0
        var counters: ShapingStatus

        init(_ rule: ShapingRule) {
            self.rule = rule
            counters = ShapingStatus(
                target: rule.ticket.target, owner: rule.ticket.owner,
                ownerGeneration: rule.ticket.ownerGeneration, revision: rule.ticket.revision
            )
        }
    }

    private let clock: MonotonicClock
    private let ruleSource: ShapingRuleSource
    private let lock = NSLock()
    private var lastNow: UInt64 = 0
    private var pauseID: UInt64 = 0
    private var flows: [UUID: Flow] = [:]
    private var timelines: [NetworkRuleTarget: Timeline] = [:]
    private var refused: [NetworkRuleTarget: ShapingStatus] = [:]
    private var refusedOrder: [NetworkRuleTarget] = []
    private var unknownCallbacks: UInt64 = 0

    public init(clock: MonotonicClock, ruleSource: ShapingRuleSource) {
        self.clock = clock
        self.ruleSource = ruleSource
    }

    public var untrackedDataCallbacks: UInt64 {
        lock.lock()
        defer { lock.unlock() }
        return unknownCallbacks
    }

    public func newFlow(_ flow: UUID, target: NetworkRuleTarget, transport: FlowTransport) -> NewFlowDecision {
        lock.lock()
        defer { lock.unlock() }
        let now = monotonicNow()
        guard let rule = ruleSource.shapingRule(for: target) else { return .allow }
        // A duplicate admission must not orphan an outstanding timer token.
        if let existing = flows[flow] {
            if let pending = existing.pending { return .pause(pending.pause) }
            return newFilter(rule.profile)
        }
        guard ensureTimeline(rule) else {
            countRefusal(rule)
            return .drop
        }
        if flows.count >= Self.maximumFlows {
            let candidate = flows.filter { _, value in
                value.pending == nil && now - value.lastActive >= Self.idleEvictionNanoseconds
            }.min { lhs, rhs in
                (lhs.value.lastActive, lhs.key.uuidString) < (rhs.value.lastActive, rhs.key.uuidString)
            }
            guard let candidate else {
                increment(target, \.refusedFlows)
                return .drop
            }
            flows.removeValue(forKey: candidate.key)
        }
        var tracked = Flow(target: target, transport: transport, lastActive: now)
        let hold = transport == .stream ?
            rule.profile.delayNanoseconds(.outbound) + rule.profile.delayNanoseconds(.inbound) : 0
        if hold > 0 {
            guard hold <= UInt64.max - now,
                  let token = makePause(flow, phase: .newFlow, release: now + hold)
            else {
                countDrop(target)
                return .drop
            }
            tracked.pending = Pending(pause: token, ticket: rule.ticket, bytes: 0)
            flows[flow] = tracked
            return .pause(token)
        }
        flows[flow] = tracked
        return newFilter(rule.profile)
    }

    public func data(_ flow: UUID, direction: FlowDirection, availableBytes: Int) -> DataDecision {
        lock.lock()
        defer { lock.unlock() }
        let now = monotonicNow()
        guard var tracked = flows[flow] else {
            unknownCallbacks = Self.add(unknownCallbacks, 1)
            return .allow
        }
        guard let rule = ruleSource.shapingRule(for: tracked.target) else {
            // Keep a paused flow's token until resume/settlement so its owner can
            // still settle it exactly once. Allow stops data filtering meanwhile.
            if tracked.pending == nil { flows.removeValue(forKey: flow) }
            return .allow
        }
        guard ensureTimeline(rule) else {
            countRefusal(rule)
            return .drop
        }
        let peek = rule.profile.quantum(direction)
        tracked.lastActive = now
        if tracked.pending != nil { increment(tracked.target, \.callbacksWhilePaused) }
        guard availableBytes > 0 else {
            flows[flow] = tracked
            return .pass(bytes: 0, peekBytes: peek)
        }
        let bytes = grant(availableBytes, tracked.transport, rule.profile, direction)
        if tracked.pending != nil {
            chargeDebt(bytes, target: tracked.target, direction: direction, now: now)
            tracked.record(direction, now: now)
            flows[flow] = tracked
            return .pass(bytes: bytes, peekBytes: peek)
        }
        return reserveData(flow, direction: direction, bytes: bytes, tracked: tracked, rule: rule, now: now)
    }

    /// Nil for an already settled/foreign token. An early same-ticket timer is
    /// ignored without consuming the pause; its caller must retain the deadline.
    /// Reset/replacement may settle immediately even before that deadline.
    public func resume(_ pause: FlowPause) -> ResumeDecision? {
        lock.lock()
        defer { lock.unlock() }
        let now = monotonicNow()
        guard var tracked = flows[pause.flow], let pending = tracked.pending, pending.pause == pause else { return nil }
        guard let rule = ruleSource.shapingRule(for: tracked.target) else {
            flows.removeValue(forKey: pause.flow)
            return .allow
        }
        let same = rule.ticket == pending.ticket
        guard !same || now >= pause.resumeAtNanoseconds else { return nil }
        guard ensureTimeline(rule) else { return nil }
        tracked.pending = nil
        tracked.lastActive = now
        switch pause.phase {
        case .newFlow:
            flows[pause.flow] = tracked
            return resumedFilter(rule.profile)
        case let .data(direction):
            let bytes = same ? pending.bytes : grant(pending.bytes, tracked.transport, rule.profile, direction)
            if same { countRelease(bytes, tracked.target, direction) }
            else { chargeDebt(bytes, target: tracked.target, direction: direction, now: now) }
            tracked.record(direction, now: now)
            flows[pause.flow] = tracked
            return .pass(bytes: bytes, peekBytes: rule.profile.quantum(direction))
        }
    }

    public func flowEnded(_ flow: UUID) -> FlowSettlement? {
        lock.lock()
        defer { lock.unlock() }
        return flows.removeValue(forKey: flow)?.pending.map { FlowSettlement(pause: $0.pause, decision: .allow) }
    }

    /// Reset/expiry cancels stale timers and allows their flows exactly once.
    /// A different active ticket is settled by resume under that current rule.
    public func settleStale() -> [FlowSettlement] {
        lock.lock()
        defer { lock.unlock() }
        let stale = flows.filter { _, flow in
            flow.pending != nil && ruleSource.shapingRule(for: flow.target) == nil
        }.keys
        let settlements = stale.compactMap { flows.removeValue(forKey: $0)?.pending }
            .map { FlowSettlement(pause: $0.pause, decision: .allow) }
        pruneTimelines()
        return settlements.sorted { $0.pause.id < $1.pause.id }
    }

    public func removeAll() -> [FlowSettlement] {
        lock.lock()
        defer { lock.unlock() }
        let settlements = flows.values.compactMap(\.pending).map { FlowSettlement(pause: $0.pause, decision: .allow) }
        flows.removeAll()
        timelines.removeAll()
        refused.removeAll()
        refusedOrder.removeAll()
        unknownCallbacks = 0
        return settlements.sorted { $0.pause.id < $1.pause.id }
    }

    /// Deterministic device-set/UDID/bundle order; refreshes current tickets.
    /// Refused-only targets have a bounded 64-entry diagnostic history.
    public func status() -> [ShapingStatus] {
        lock.lock()
        defer { lock.unlock() }
        for target in Array(timelines.keys) {
            if let rule = ruleSource.shapingRule(for: target) { _ = ensureTimeline(rule) }
        }
        let active = timelines.compactMap { target, timeline -> ShapingStatus? in
            guard ruleSource.shapingRule(for: target) != nil else { return nil }
            var status = timeline.counters
            let tracked = flows.values.filter { $0.target == target }
            status.trackedFlows = tracked.count
            status.pausedFlows = tracked.filter { $0.pending != nil }.count
            return status
        }
        let rejected = refused.compactMap { target, value -> ShapingStatus? in
            guard let rule = ruleSource.shapingRule(for: target) else { return nil }
            return rule.ticket.owner == value.owner && rule.ticket.ownerGeneration == value.ownerGeneration &&
                rule.ticket.revision == value.revision ? value : Timeline(rule).counters
        }
        return (active + rejected).sorted {
            ($0.target.simulator.deviceSet, $0.target.simulator.udid, $0.target.bundleId) <
                ($1.target.simulator.deviceSet, $1.target.simulator.udid, $1.target.bundleId)
        }
    }

    // MARK: - Helpers (lock held)

    private func reserveData(
        _ flow: UUID,
        direction: FlowDirection,
        bytes: Int,
        tracked: Flow,
        rule: ShapingRule,
        now: UInt64
    )
        -> DataDecision
    {
        var tracked = tracked
        let peek = rule.profile.quantum(direction)
        let last = tracked.activity(direction)
        let hold = last == nil || now - (last ?? now) >= rule.profile.quietGapNanoseconds ?
            rule.profile.delayNanoseconds(direction) : 0
        tracked.record(direction, now: now)
        let slot = slotStart(tracked.target, direction, now)
        let release = max(Self.add(now, hold), slot)
        let limit = tracked.transport == .datagram ?
            Self.maximumDatagramPauseNanoseconds : Self.maximumStreamPauseNanoseconds
        guard hold <= UInt64.max - now,
              !(rule.profile.rate(direction) != nil && slot == UInt64.max),
              release - now <= limit
        else {
            countDrop(tracked.target)
            flows[flow] = tracked
            return .drop
        }
        var token: FlowPause?
        if release > now {
            guard let value = makePause(flow, phase: .data(direction), release: release) else {
                countDrop(tracked.target)
                return .drop
            }
            token = value
        }
        charge(bytes, target: tracked.target, direction: direction, now: now)
        tracked.record(direction, now: now)
        if hold > 0 { countHold(tracked.target, direction) }
        if let token {
            tracked.pending = Pending(pause: token, ticket: rule.ticket, bytes: bytes)
            flows[flow] = tracked
            return .pause(token)
        }
        countRelease(bytes, tracked.target, direction)
        flows[flow] = tracked
        return .pass(bytes: bytes, peekBytes: peek)
    }

    private func monotonicNow() -> UInt64 {
        lastNow = max(lastNow, clock.nowNanoseconds())
        return lastNow
    }

    private func ensureTimeline(_ rule: ShapingRule) -> Bool {
        let target = rule.ticket.target
        if timelines[target]?.rule.ticket == rule.ticket { return true }
        if timelines[target] == nil {
            pruneTimelines()
            guard timelines.count < Self.maximumTimelines else { return false }
        }
        var timeline = Timeline(rule)
        if let previous = refused.removeValue(forKey: target), previous.owner == rule.ticket.owner,
           previous.ownerGeneration == rule.ticket.ownerGeneration, previous.revision == rule.ticket.revision
        { timeline.counters.refusedFlows = previous.refusedFlows }
        refusedOrder.removeAll { $0 == target }
        timelines[target] = timeline
        return true
    }

    private func pruneTimelines() {
        for target in Array(timelines.keys) where ruleSource.shapingRule(for: target) == nil {
            timelines.removeValue(forKey: target)
        }
    }

    private func countRefusal(_ rule: ShapingRule) {
        let target = rule.ticket.target
        var value = refused[target] ?? Timeline(rule).counters
        if value.owner != rule.ticket.owner || value.ownerGeneration != rule.ticket.ownerGeneration ||
            value.revision != rule.ticket.revision
        { value = Timeline(rule).counters }
        value.refusedFlows = Self.add(value.refusedFlows, 1)
        if refused[target] == nil { refusedOrder.append(target) }
        refused[target] = value
        while refusedOrder.count > Self.maximumRefusedTargets {
            refused.removeValue(forKey: refusedOrder.removeFirst())
        }
    }

    private func grant(_ bytes: Int, _ transport: FlowTransport, _ profile: ShapingProfile, _ direction: FlowDirection)
        -> Int
    {
        // An unlimited direction passes all offered bytes, even on streams.
        transport == .stream && profile.rate(direction) != nil ? min(bytes, profile.quantum(direction)) : bytes
    }

    private func newFilter(_ profile: ShapingProfile) -> NewFlowDecision {
        .filter(inbound: profile.shapes(.inbound), outbound: profile.shapes(.outbound), peekBytes: filterPeek(profile))
    }

    private func resumedFilter(_ profile: ShapingProfile) -> ResumeDecision {
        .filter(inbound: profile.shapes(.inbound), outbound: profile.shapes(.outbound), peekBytes: filterPeek(profile))
    }

    private func filterPeek(_ profile: ShapingProfile) -> Int {
        // New-flow verdicts have one peek value: use the smaller shaped quantum.
        [FlowDirection.inbound, .outbound].filter(profile.shapes).map(profile.quantum).min() ?? 65536
    }

    private func makePause(_ flow: UUID, phase: FlowPause.Phase, release: UInt64) -> FlowPause? {
        guard pauseID < UInt64.max else { return nil }
        pauseID += 1
        return FlowPause(flow: flow, id: pauseID, resumeAtNanoseconds: release, phase: phase)
    }

    private func slotStart(_ target: NetworkRuleTarget, _ direction: FlowDirection, _ now: UInt64) -> UInt64 {
        guard let timeline = timelines[target], timeline.rule.profile.rate(direction) != nil else { return now }
        return max(now, direction == .inbound ? timeline.inboundNext : timeline.outboundNext)
    }

    private func charge(_ bytes: Int, target: NetworkRuleTarget, direction: FlowDirection, now: UInt64) {
        guard let rate = timelines[target]?.rule.profile.rate(direction) else { return }
        let next = Self.add(slotStart(target, direction, now), Self.duration(bytes, rate))
        if direction == .inbound { timelines[target]?.inboundNext = next }
        else { timelines[target]?.outboundNext = next }
    }

    private func chargeDebt(_ bytes: Int, target: NetworkRuleTarget, direction: FlowDirection, now: UInt64) {
        charge(bytes, target: target, direction: direction, now: now)
        increment(target, \.debtReleases)
        countRelease(bytes, target, direction)
    }

    private func increment(
        _ target: NetworkRuleTarget,
        _ counter: WritableKeyPath<ShapingStatus, UInt64>,
        by amount: UInt64 = 1
    ) {
        guard var timeline = timelines[target] else { return }
        timeline.counters[keyPath: counter] = Self.add(timeline.counters[keyPath: counter], amount)
        timelines[target] = timeline
    }

    private func countRelease(_ bytes: Int, _ target: NetworkRuleTarget, _ direction: FlowDirection) {
        increment(target, direction == .inbound ? \.inboundReleasedBytes : \.outboundReleasedBytes, by: UInt64(bytes))
    }

    private func countHold(_ target: NetworkRuleTarget, _ direction: FlowDirection) {
        increment(target, direction == .inbound ? \.inboundHeldBursts : \.outboundHeldBursts)
    }

    private func countDrop(_ target: NetworkRuleTarget) {
        increment(target, \.overBudgetDrops)
    }

    /// Full-width multiply/divide avoids intermediate overflow for Int.max
    /// datagrams. Unrepresentable durations saturate, never wrap into early slots.
    private static func duration(_ bytes: Int, _ rate: UInt64) -> UInt64 {
        let product = UInt64(bytes).multipliedFullWidth(by: 1_000_000_000)
        guard product.high < rate else { return .max }
        let result = rate.dividingFullWidth(product)
        return add(result.quotient, result.remainder == 0 ? 0 : 1)
    }

    private static func add(_ lhs: UInt64, _ rhs: UInt64) -> UInt64 {
        let result = lhs.addingReportingOverflow(rhs)
        return result.overflow ? .max : result.partialValue
    }
}
