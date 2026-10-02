import Foundation
import os

/// Records named intervals and converts them to the existing nested `PerfTiming` wire shape.
///
/// Each scope keeps a flat list of interval values and a stack of list indexes. Durations come
/// directly from the injected clock at interval start and end. Parent indexes retain nesting
/// while avoiding a mutable object tree; the wire tree is assembled only for a completed root,
/// `peek()`, or `snapshot(_:)`. A task-local UUID carries the active scope across actor hops, and
/// the lock protects scope state and the shared completed-root/debounce pool.
final class PerfProvider: PerfTracking {
    private struct Interval {
        let name: String
        let startTime: Int64
        let parent: Int?
        var endTime: Int64?
    }

    private struct Scope {
        var intervals: [Interval] = []
        var stack: [Int] = []
    }

    private struct Shared {
        var scopes: [UUID: Scope] = [:]
        var completed: [PerfTiming] = []
        var debounceCount = 0
        var lastDebounceTime: Int64?
    }

    @TaskLocal private static var activeScopeID: UUID?

    private let shared = OSAllocatedUnfairLock(initialState: Shared())
    private let timeProvider: any TimeProvider

    init(timeProvider: any TimeProvider = SystemTimeProvider()) {
        self.timeProvider = timeProvider
    }

    /// Bind a fresh interval scope for this synchronous operation.
    func withScope<T>(_ body: () throws -> T) rethrows -> T {
        let id = createScope()
        defer { removeScope(id) }
        return try PerfProvider.$activeScopeID.withValue(id, operation: body)
    }

    /// Bind a fresh interval scope across async work and actor hops.
    func withScope<T>(_ body: nonisolated(nonsending)() async throws -> T) async rethrows -> T {
        let id = createScope()
        defer { removeScope(id) }
        return try await PerfProvider.$activeScopeID.withValue(id, operation: body)
    }

    private func createScope() -> UUID {
        let id = UUID()
        shared.withLock { $0.scopes[id] = Scope() }
        return id
    }

    private func removeScope(_ id: UUID) {
        shared.withLock { _ = $0.scopes.removeValue(forKey: id) }
    }

    // MARK: - Interval recording

    func serial(_ name: String) { start(name) }

    func parallel(_ name: String) { start(name) }

    func independentRoot(_ name: String) {
        guard let id = Self.activeScopeID else { return }
        let now = timeProvider.currentTimeMillis()
        shared.withLock { state in
            guard var scope = state.scopes[id] else { return }
            closeOpenIntervals(&scope, at: now, into: &state.completed)
            start(name, at: now, in: &scope)
            state.scopes[id] = scope
        }
    }

    private func start(_ name: String) {
        guard let id = Self.activeScopeID else { return }
        let now = timeProvider.currentTimeMillis()
        shared.withLock { state in
            guard var scope = state.scopes[id] else { return }
            start(name, at: now, in: &scope)
            state.scopes[id] = scope
        }
    }

    private func start(_ name: String, at now: Int64, in scope: inout Scope) {
        let parent = scope.stack.last
        scope.intervals.append(Interval(name: name, startTime: now, parent: parent))
        scope.stack.append(scope.intervals.count - 1)
    }

    func end() {
        guard let id = Self.activeScopeID else { return }
        let now = timeProvider.currentTimeMillis()
        shared.withLock { state in
            guard var scope = state.scopes[id] else { return }
            closeLastInterval(&scope, at: now, into: &state.completed)
            state.scopes[id] = scope
        }
    }

    @discardableResult
    func track<T>(_ name: String, block: () throws -> T) rethrows -> T {
        startOperation(name)
        defer { endOperation(name) }
        return try block()
    }

    @discardableResult
    func trackAsync<T>(_ name: String, block: () async throws -> T) async rethrows -> T {
        startOperation(name)
        defer { endOperation(name) }
        return try await block()
    }

    func startOperation(_ name: String) { start(name) }

    func endOperation(_ name: String) {
        guard let id = Self.activeScopeID else { return }
        let now = timeProvider.currentTimeMillis()
        shared.withLock { state in
            guard var scope = state.scopes[id],
                  let index = scope.stack.last,
                  scope.intervals[index].name == name else { return }
            closeLastInterval(&scope, at: now, into: &state.completed)
            state.scopes[id] = scope
        }
    }

    private func closeOpenIntervals(_ scope: inout Scope, at now: Int64, into completed: inout [PerfTiming]) {
        while !scope.stack.isEmpty {
            closeLastInterval(&scope, at: now, into: &completed)
        }
    }

    private func closeLastInterval(_ scope: inout Scope, at now: Int64, into completed: inout [PerfTiming]) {
        guard let index = scope.stack.popLast() else { return }
        scope.intervals[index].endTime = now
        guard scope.stack.isEmpty else { return }

        completed.append(timing(at: index, in: scope.intervals, now: now))
        scope.intervals.removeAll(keepingCapacity: true)
    }

    private func timing(at index: Int, in intervals: [Interval], now: Int64) -> PerfTiming {
        let interval = intervals[index]
        let children = intervals.indices.filter { intervals[$0].parent == index }
        let childTimings = children.map { timing(at: $0, in: intervals, now: now) }
        return PerfTiming(
            name: interval.name,
            durationMs: (interval.endTime ?? now) - interval.startTime,
            children: childTimings.isEmpty ? nil : childTimings
        )
    }

    // MARK: - Debounce tracking

    func recordDebounce() {
        let now = timeProvider.currentTimeMillis()
        shared.withLock {
            $0.debounceCount += 1
            $0.lastDebounceTime = now
        }
    }

    // MARK: - Flush and query

    func flush() -> [PerfTiming]? {
        let now = timeProvider.currentTimeMillis()
        return shared.withLock { state in
            if let id = Self.activeScopeID, var scope = state.scopes[id] {
                closeOpenIntervals(&scope, at: now, into: &state.completed)
                state.scopes[id] = scope
            }

            var entries = state.completed
            state.completed.removeAll()
            if state.debounceCount > 0 {
                entries.append(PerfTiming(
                    name: "debounce",
                    durationMs: 0,
                    children: [
                        .timing("count", durationMs: Int64(state.debounceCount)),
                        .timing("lastTime", durationMs: state.lastDebounceTime ?? 0),
                    ]
                ))
                state.debounceCount = 0
                state.lastDebounceTime = nil
            }
            return entries.isEmpty ? nil : entries
        }
    }

    func peek() -> [PerfTiming] {
        let now = timeProvider.currentTimeMillis()
        return shared.withLock { state in
            var entries: [PerfTiming] = []
            if let id = Self.activeScopeID,
               let scope = state.scopes[id],
               let root = scope.stack.first
            {
                entries.append(timing(at: root, in: scope.intervals, now: now))
            }
            entries.append(contentsOf: state.completed)
            return entries
        }
    }

    func snapshot(_ name: String) -> PerfTiming? {
        let now = timeProvider.currentTimeMillis()
        return shared.withLock { state in
            guard let id = Self.activeScopeID,
                  let scope = state.scopes[id],
                  let index = scope.stack.reversed().first(where: { scope.intervals[$0].name == name })
            else {
                return nil
            }
            return timing(at: index, in: scope.intervals, now: now)
        }
    }

    var hasData: Bool {
        shared.withLock { state in
            !state.completed.isEmpty || state.debounceCount > 0 ||
                (Self.activeScopeID.flatMap { state.scopes[$0]?.stack.isEmpty == false } ?? false)
        }
    }

    func clear() {
        shared.withLock { state in
            if let id = Self.activeScopeID { state.scopes[id] = Scope() }
            state.completed.removeAll()
            state.debounceCount = 0
            state.lastDebounceTime = nil
        }
    }
}

/// Gesture diagnostics use the server's injected monotonic clock, including queue wait.
/// The only wire representation is the existing optional PerfTiming tree.
protocol GestureLogSink: Sendable {
    func warning(_ line: String)
}

struct SystemGestureLogSink: GestureLogSink {
    private let logger = Logger(subsystem: "dev.jasonpearson.automobile", category: "GesturePerformer")
    func warning(_ line: String) { logger.warning("\(line, privacy: .public)") }
}

final class GesturePhaseDiagnostics: Sendable {
    static let slowGestureThresholdMs: Int64 = 2000
    @TaskLocal static var current: GesturePhaseDiagnostics?

    private struct State {
        var phase = "queueWait"
        var phaseStarted: Int64
        var phases: [PerfTiming] = []
        var deadlineExceeded = false
        var phaseAtBound: String?
        var elapsedAtBoundMs: Int64?
        var finished: PerfTiming?
    }

    private let state: OSAllocatedUnfairLock<State>
    private let now: @Sendable () -> Int64
    private let receivedAtMs: Int64
    private let command: String
    private let deadlineMs: Int64?
    private let sink: any GestureLogSink

    init(
        command: String,
        receivedAtMs: Int64,
        deadlineMs: Int64?,
        now: @escaping @Sendable () -> Int64,
        sink: any GestureLogSink
    ) {
        self.command = command
        self.receivedAtMs = receivedAtMs
        self.deadlineMs = deadlineMs
        self.now = now
        self.sink = sink
        state = OSAllocatedUnfairLock(initialState: State(phaseStarted: receivedAtMs))
    }

    func begin(_ phase: String, at time: Int64? = nil) {
        let time = time ?? now()
        state.withLock {
            guard $0.finished == nil else { return }
            $0.phases.append(.timing($0.phase, durationMs: time - $0.phaseStarted))
            $0.phase = phase
            $0.phaseStarted = time
        }
    }

    var currentPhase: String { state.withLock { $0.phase } }

    /// Elapsed time includes queue wait, matching the final gesturePhases total.
    @discardableResult
    func markBoundExceeded(boundMs: Int64) -> (phase: String, elapsedMs: Int64) {
        let time = now()
        let (phase, elapsed, shouldLog) = state.withLock { value -> (String, Int64, Bool) in
            if let phase = value.phaseAtBound, let elapsed = value.elapsedAtBoundMs {
                return (phase, elapsed, false)
            }
            let elapsed = time - receivedAtMs
            value.phaseAtBound = value.phase
            value.elapsedAtBoundMs = elapsed
            return (value.phase, elapsed, true)
        }
        if shouldLog {
            let remaining = deadlineMs.map { String($0 - time) } ?? "none"
            sink.warning(
                "gesture_phases command=\(command) boundHit=true phaseAtBound=\(phase) boundMs=\(boundMs) elapsedMs=\(elapsed) deadlineRemainingMs=\(remaining) (still running)"
            )
        }
        return (phase, elapsed)
    }

    func markDeadlineExceeded() { state.withLock { $0.deadlineExceeded = true } }

    @discardableResult
    func finish() -> PerfTiming {
        let time = now()
        let (timing, shouldLog, phaseAtBound) = state.withLock { value -> (PerfTiming, Bool, String?) in
            if let finished = value.finished { return (finished, false, value.phaseAtBound) }
            value.phases.append(.timing(value.phase, durationMs: time - value.phaseStarted))
            let timing = PerfTiming(name: "gesturePhases", durationMs: time - receivedAtMs, children: value.phases)
            value.finished = timing
            return (
                timing,
                value.deadlineExceeded || timing.durationMs > Self.slowGestureThresholdMs || value.phaseAtBound != nil,
                value.phaseAtBound
            )
        }
        if shouldLog {
            let bound = phaseAtBound.map { " phaseAtBound=\($0)" } ?? ""
            let phases = (timing.children ?? []).map { "\($0.name)Ms=\($0.durationMs)" }.joined(separator: " ")
            let remaining = deadlineMs.map { String($0 - time) } ?? "none"
            sink
                .warning(
                    "gesture_phases command=\(command) \(phases) totalMs=\(timing.durationMs) deadlineRemainingMs=\(remaining)\(bound)"
                )
        }
        return timing
    }

    /// Preserve the no-perf path exactly; add children only to an existing perf response.
    func attaching(to timing: PerfTiming?) -> PerfTiming? {
        guard let timing else { return nil }
        return PerfTiming(
            name: timing.name,
            durationMs: timing.durationMs,
            children: (timing.children ?? []) + [finish()]
        )
    }
}
