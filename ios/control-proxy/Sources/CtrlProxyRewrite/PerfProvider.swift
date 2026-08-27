import Foundation
import os

/// Task-scoped accumulator for hierarchical performance timing data. A faithful,
/// behavior-preserving rewrite of the reference `PerfProvider`, re-expressing its two pieces
/// of state under Swift-6 strict concurrency:
///
/// - **Active call-tree → `@TaskLocal`** (was `Thread.current.threadDictionary`). The reference
///   kept the open-entry stack + current root *per thread* so an operation on one thread never
///   nested under an in-flight operation on another (issue #3635). But the rewrite moved
///   `ElementLocator` to `@MainActor`, so one hierarchy request now spans the command queue
///   *and* the main actor; a thread-local would split the tree at that boundary (the
///   `getViewHierarchy` sub-tree would land as a separate root). A task-local instead propagates
///   across `await` into the `@MainActor` collaborator *within the same task*, so the sub-tree
///   nests exactly as the reference's single-threaded tree did. Bound per operation via
///   `withScope`; outside any scope the imperative calls are safe no-ops (perf timing is
///   diagnostic, not wire-critical). **Approved design call — see STATUS §6/§9.**
/// - **Completed-root pool + debounce counters → `OSAllocatedUnfairLock<Shared>`** (was `NSLock`
///   + fields). Genuinely `Sendable`, no `@unchecked`. `flush()` drains the whole pool so command
///   handling and background hierarchy polling report their timings together — this pooled-flush
///   behavior is relied on and preserved.
///
/// The reference singleton (`nonisolated(unsafe) static var _instance` + a double-checked
/// `NSLock`) is dropped: the `WebSocketServer` and `ElementLocator` already inject
/// `any PerfTracking`, and the Phase-6 coordinator owns the single instance. The reference keyed
/// its thread-local by `ObjectIdentifier(self)` only to isolate that singleton from
/// `createForTesting`; with one injected instance the task-local needs no per-instance key.
///
/// > This subsystem is deliberately ported as-is to keep the external timing data equivalent.
/// > It is an over-elaborate way to compute the handful of intervals actually reported;
/// > replacing it with `os_signpost` / direct interval math is a queued post-critical-path
/// > fixup (see the README fixup index), not part of this concurrency migration.
final class PerfProvider: PerfTracking {
    // MARK: - Active call-tree (task-scoped)

    /// Per-operation active state: the open-entry stack and the current root.
    ///
    /// `@unchecked Sendable` because it is mutated only within a single task's *serial*
    /// execution — a task never runs on two executors simultaneously, which is the guarantee
    /// the reference got implicitly from thread confinement. Production opens no parallel perf
    /// blocks across child tasks (there are no `parallel`/`independentRoot`/`trackAsync` call
    /// sites), so no concurrent mutation of one scope occurs; and a completed root is snapshotted
    /// to an immutable `PerfTiming` before it leaves the scope for the shared pool.
    private final class PerfCallScope: @unchecked Sendable {
        var entryStack: [MutablePerfEntry] = []
        var currentRoot: MutablePerfEntry?
    }

    /// The active scope for the current task, or `nil` outside any `withScope`. Bindings are
    /// per-task (propagated across `await`, inherited by child tasks), reproducing the reference's
    /// per-thread isolation for the rewrite's task-based execution.
    @TaskLocal private static var activeScope: PerfCallScope?

    // MARK: - Shared completed-root pool (lock-confined)

    private struct Shared {
        var completed: [PerfTiming] = []
        var debounceCount = 0
        var lastDebounceTime: Int64?
    }

    private let shared = OSAllocatedUnfairLock(initialState: Shared())

    // MARK: - Dependencies

    private let timeProvider: any TimeProvider

    init(timeProvider: any TimeProvider = SystemTimeProvider()) {
        self.timeProvider = timeProvider
    }

    // MARK: - Scope binding

    /// Run `body` with a fresh active call-tree bound for the current task. Perf calls made during
    /// `body` — directly, or across an `await` into a `@MainActor` collaborator in the same task —
    /// accumulate into this scope. Entries still open when `body` returns are closed by the next
    /// `flush()`/`clear()` (matching the reference, which closed incomplete entries at flush).
    /// Phase 6 wires this at the command-handling and polling entry points.
    func withScope<T>(_ body: () throws -> T) rethrows -> T {
        try PerfProvider.$activeScope.withValue(PerfCallScope(), operation: body)
    }

    /// Async variant of `withScope` — the form the async Phase-6 command handler uses so the
    /// binding survives its `await`s into `@MainActor`/off-main collaborators. `body` is
    /// `nonisolated(nonsending)` so this resolves to the non-deprecated `TaskLocal.withValue`
    /// overload (the `isolation:`-parameter form is deprecated under Swift 6.2).
    func withScope<T>(_ body: nonisolated(nonsending) () async throws -> T) async rethrows -> T {
        try await PerfProvider.$activeScope.withValue(PerfCallScope(), operation: body)
    }

    private static var scope: PerfCallScope? { activeScope }

    // MARK: - Serial / Parallel blocks

    /// Start a serial block (operations run sequentially).
    func serial(_ name: String) {
        open(name, isParallel: false)
    }

    /// Start a parallel block (operations run concurrently). `isParallel` never reaches the wire,
    /// so this differs from `serial` only in the (unserialized) flag — preserved for fidelity.
    func parallel(_ name: String) {
        open(name, isParallel: true)
    }

    /// Start a new independent root block, ending any currently open blocks on this scope first.
    func independentRoot(_ name: String) {
        guard let scope = PerfProvider.scope else { return }
        while !scope.entryStack.isEmpty {
            endInternal(scope)
        }
        let entry = MutablePerfEntry(name: name, startTime: timeProvider.currentTimeMillis(), isParallel: false)
        scope.currentRoot = entry
        scope.entryStack.append(entry)
    }

    /// Shared open logic for `serial` / `parallel` / `startOperation` (all identical in the
    /// reference aside from the `isParallel` flag).
    private func open(_ name: String, isParallel: Bool) {
        guard let scope = PerfProvider.scope else { return }
        let entry = MutablePerfEntry(name: name, startTime: timeProvider.currentTimeMillis(), isParallel: isParallel)
        if let parent = scope.entryStack.last {
            parent.children.append(entry)
        } else {
            scope.currentRoot = entry
        }
        scope.entryStack.append(entry)
    }

    /// End the current (innermost open) block.
    func end() {
        guard let scope = PerfProvider.scope else { return }
        endInternal(scope)
    }

    /// End the innermost open entry on `scope`; move it to the shared pool if it was the root.
    private func endInternal(_ scope: PerfCallScope) {
        let now = timeProvider.currentTimeMillis()
        guard let entry = scope.entryStack.popLast() else {
            return
        }
        entry.endTime = now
        if scope.entryStack.isEmpty, scope.currentRoot === entry {
            scope.currentRoot = nil
            appendCompleted(entry)
        }
    }

    // MARK: - Track operations

    /// Track a synchronous operation with automatic start/end timing.
    @discardableResult
    func track<T>(_ name: String, block: () throws -> T) rethrows -> T {
        startOperation(name)
        defer { endOperation(name) }
        return try block()
    }

    /// Track an async operation with automatic start/end timing. The task-local scope survives the
    /// `await`, so a sub-operation running on another executor still nests correctly.
    @discardableResult
    func trackAsync<T>(_ name: String, block: () async throws -> T) async rethrows -> T {
        startOperation(name)
        defer { endOperation(name) }
        return try await block()
    }

    /// Start tracking an operation manually (identical to `serial`).
    func startOperation(_ name: String) {
        open(name, isParallel: false)
    }

    /// End tracking a named operation manually. A mismatched name is a no-op (matching the
    /// reference), so an unbalanced `endOperation` cannot pop the wrong entry.
    func endOperation(_ name: String) {
        guard let scope = PerfProvider.scope else { return }
        let now = timeProvider.currentTimeMillis()
        guard let entry = scope.entryStack.last, entry.name == name else {
            return
        }
        entry.endTime = now
        _ = scope.entryStack.popLast()
        if scope.entryStack.isEmpty, scope.currentRoot === entry {
            scope.currentRoot = nil
            appendCompleted(entry)
        }
    }

    /// Snapshot a completed root to an immutable `PerfTiming` and move it into the shared pool.
    /// The reference stored the mutable entry and converted at flush; converting eagerly here is
    /// behaviorally identical (a root and its children are all fully timed by the time the root
    /// completes) and keeps the pool genuinely `Sendable`.
    private func appendCompleted(_ entry: MutablePerfEntry) {
        let timing = entry.toTiming(timeProvider: timeProvider)
        shared.withLock { $0.completed.append(timing) }
    }

    // MARK: - Debounce tracking

    /// Record a debounce event (when hierarchy updates are debounced).
    func recordDebounce() {
        let now = timeProvider.currentTimeMillis()
        shared.withLock {
            $0.debounceCount += 1
            $0.lastDebounceTime = now
        }
    }

    // MARK: - Flush and query

    /// Flush all accumulated timing data and reset, returning it for inclusion in a WebSocket
    /// message. Closes any entries still open on the current scope first (moving their roots into
    /// the shared pool), then drains the pool + debounce info under the lock.
    func flush() -> [PerfTiming]? {
        // Close incomplete entries before taking the lock to avoid re-entrant locking (each
        // completed root takes the lock once via appendCompleted).
        if let scope = PerfProvider.scope {
            while !scope.entryStack.isEmpty {
                endInternal(scope)
            }
        }

        return shared.withLock { state -> [PerfTiming]? in
            var entries = state.completed
            state.completed.removeAll()

            if state.debounceCount > 0 {
                entries.append(PerfTiming(
                    name: "debounce",
                    durationMs: 0,
                    children: [
                        PerfTiming.timing("count", durationMs: Int64(state.debounceCount)),
                        PerfTiming.timing("lastTime", durationMs: state.lastDebounceTime ?? 0),
                    ]
                ))
                state.debounceCount = 0
                state.lastDebounceTime = nil
            }

            return entries.isEmpty ? nil : entries
        }
    }

    /// Get current timing data without clearing (for debugging): the current scope's root (if any)
    /// followed by the shared completed roots.
    func peek() -> [PerfTiming] {
        var entries: [PerfTiming] = []
        if let root = PerfProvider.scope?.currentRoot {
            entries.append(root.toTiming(timeProvider: timeProvider))
        }
        entries.append(contentsOf: shared.withLock { $0.completed })
        return entries
    }

    /// Whether there is any accumulated timing data (current-scope root, pooled roots, or debounce).
    var hasData: Bool {
        let hasLocalRoot = PerfProvider.scope?.currentRoot != nil
        return shared.withLock { !$0.completed.isEmpty || hasLocalRoot || $0.debounceCount > 0 }
    }

    /// Clear all timing data without returning it.
    func clear() {
        if let scope = PerfProvider.scope {
            scope.entryStack.removeAll()
            scope.currentRoot = nil
        }
        shared.withLock {
            $0.completed.removeAll()
            $0.debounceCount = 0
            $0.lastDebounceTime = nil
        }
    }
}
