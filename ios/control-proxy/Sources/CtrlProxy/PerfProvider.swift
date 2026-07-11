import Foundation

// MARK: - TimeProvider Protocol

/// Protocol for providing current time in milliseconds. Uses injection for testability.
public protocol TimeProvider {
    /// Get current time in milliseconds (epoch time)
    func currentTimeMillis() -> Int64
}

/// Default implementation using system clock.
public class SystemTimeProvider: TimeProvider {
    public init() {}

    public func currentTimeMillis() -> Int64 {
        return Int64(Date().timeIntervalSince1970 * 1000)
    }
}

/// Fake implementation for testing with controllable time.
public class FakeTimeProvider: TimeProvider {
    private var currentTime: Int64
    private let lock = NSLock()

    public init(initialTime: Int64 = 0) {
        currentTime = initialTime
    }

    public func currentTimeMillis() -> Int64 {
        lock.lock()
        defer { lock.unlock() }
        return currentTime
    }

    /// Set the current time to a specific value.
    public func setTime(_ time: Int64) {
        lock.lock()
        defer { lock.unlock() }
        currentTime = time
    }

    /// Advance time by the specified number of milliseconds.
    public func advance(by milliseconds: Int64) {
        lock.lock()
        defer { lock.unlock() }
        currentTime += milliseconds
    }

    /// Reset time to zero.
    public func reset() {
        lock.lock()
        defer { lock.unlock() }
        currentTime = 0
    }
}

// MARK: - Timer Protocol (for delays and scheduling)

/// Protocol for timer/delay operations. Uses injection for testability.
public protocol Timer {
    /// Get current time in milliseconds
    func now() -> Int64

    /// Wait for specified milliseconds (async)
    func wait(milliseconds: Int64) async

    /// Schedule a callback after specified milliseconds
    func schedule(after milliseconds: Int64, callback: @escaping @Sendable () -> Void)
}

/// Default implementation using real system time and delays.
public class SystemTimer: Timer, @unchecked Sendable {
    public init() {}

    public func now() -> Int64 {
        return Int64(Date().timeIntervalSince1970 * 1000)
    }

    public func wait(milliseconds: Int64) async {
        try? await Task.sleep(nanoseconds: UInt64(milliseconds) * 1_000_000)
    }

    public func schedule(after milliseconds: Int64, callback: @escaping @Sendable () -> Void) {
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(Int(milliseconds))) {
            callback()
        }
    }
}

/// Fake implementation for testing with instant or controlled time.
public class FakeTimer: Timer, @unchecked Sendable {
    public enum Mode {
        case instant // All waits complete immediately
        case manual // Waits only complete when manually advanced
        case delayed(Int64) // Each wait takes a fixed duration
    }

    private let mode: Mode
    private var currentTime: Int64
    private let lock = NSLock()
    private var pendingCallbacks: [(time: Int64, callback: @Sendable () -> Void)] = []
    private var pendingWaiters: [CheckedContinuation<Void, Never>] = []

    public init(mode: Mode = .instant, initialTime: Int64 = 0) {
        self.mode = mode
        currentTime = initialTime
    }

    public func now() -> Int64 {
        lock.lock()
        defer { lock.unlock() }
        return currentTime
    }

    /// Helper to update time in a thread-safe manner (called from non-async contexts)
    private func incrementTime(by milliseconds: Int64) {
        lock.lock()
        currentTime += milliseconds
        lock.unlock()
    }

    /// Helper to add a waiter (called from withCheckedContinuation)
    private func addWaiter(_ continuation: CheckedContinuation<Void, Never>) {
        lock.lock()
        pendingWaiters.append(continuation)
        lock.unlock()
    }

    public func wait(milliseconds: Int64) async {
        switch mode {
        case .instant:
            incrementTime(by: milliseconds)
            return

        case .manual:
            await withCheckedContinuation { continuation in
                self.addWaiter(continuation)
            }

        case let .delayed(delay):
            try? await Task.sleep(nanoseconds: UInt64(delay) * 1_000_000)
            incrementTime(by: milliseconds)
        }
    }

    public func schedule(after milliseconds: Int64, callback: @escaping @Sendable () -> Void) {
        lock.lock()
        let targetTime = currentTime + milliseconds
        pendingCallbacks.append((time: targetTime, callback: callback))
        lock.unlock()

        if case .instant = mode {
            advance(by: milliseconds)
        }
    }

    /// Advance time by the specified number of milliseconds.
    /// Triggers any scheduled callbacks that should fire.
    public func advance(by milliseconds: Int64) {
        lock.lock()
        currentTime += milliseconds

        // Find and execute callbacks that should fire
        let toExecute = pendingCallbacks.filter { $0.time <= currentTime }
        pendingCallbacks.removeAll { $0.time <= currentTime }

        // Resume any pending waiters
        let waiters = pendingWaiters
        pendingWaiters.removeAll()
        lock.unlock()

        for item in toExecute.sorted(by: { $0.time < $1.time }) {
            item.callback()
        }

        for waiter in waiters {
            waiter.resume()
        }
    }

    /// Set the current time to a specific value.
    public func setTime(_ time: Int64) {
        lock.lock()
        currentTime = time
        lock.unlock()
    }

    /// Reset time to zero and clear pending callbacks.
    public func reset() {
        lock.lock()
        currentTime = 0
        pendingCallbacks.removeAll()
        let waiters = pendingWaiters
        pendingWaiters.removeAll()
        lock.unlock()

        for waiter in waiters {
            waiter.resume()
        }
    }

    /// Get count of pending scheduled callbacks.
    public var pendingCallbackCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return pendingCallbacks.count
    }

    /// Get count of pending waiters.
    public var pendingWaiterCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return pendingWaiters.count
    }
}

// MARK: - Mutable Perf Entry

/// Internal mutable timing entry for building up timing data.
class MutablePerfEntry {
    let name: String
    let startTime: Int64
    var endTime: Int64?
    var children: [MutablePerfEntry] = []
    let isParallel: Bool

    init(name: String, startTime: Int64, isParallel: Bool = false) {
        self.name = name
        self.startTime = startTime
        self.isParallel = isParallel
    }

    func toTiming(timeProvider: TimeProvider) -> PerfTiming {
        let duration = (endTime ?? timeProvider.currentTimeMillis()) - startTime
        let childTimings: [PerfTiming]? = children.isEmpty ? nil : children
            .map { $0.toTiming(timeProvider: timeProvider) }
        return PerfTiming(name: name, durationMs: duration, children: childTimings)
    }
}

// MARK: - PerfProvider

/// Thread-safe provider for accumulating performance timing data.
///
/// Usage:
/// ```swift
/// let perf = PerfProvider.instance
///
/// // Track an operation
/// let result = perf.track("operationName") {
///     // do work
///     return someValue
/// }
///
/// // Or manually track
/// perf.startOperation("operationName")
/// // do work
/// perf.endOperation("operationName")
///
/// // When sending a WebSocket message, flush all timing data
/// let timings = perf.flush()
/// ```
public class PerfProvider {
    // MARK: - Singleton

    // Using nonisolated(unsafe) because thread safety is managed manually via instanceLock
    private nonisolated(unsafe) static var _instance: PerfProvider?
    private static let instanceLock = NSLock()

    public static var instance: PerfProvider {
        instanceLock.lock()
        defer { instanceLock.unlock() }

        if _instance == nil {
            _instance = PerfProvider()
        }
        return _instance!
    }

    /// For testing - allows injecting a custom TimeProvider.
    public static func createForTesting(timeProvider: TimeProvider) -> PerfProvider {
        return PerfProvider(timeProvider: timeProvider)
    }

    /// Reset the singleton instance (for testing).
    public static func resetInstance() {
        instanceLock.lock()
        defer { instanceLock.unlock() }
        _instance = nil
    }

    // MARK: - Properties

    private let timeProvider: TimeProvider

    /// Guards the shared completed-entry pool and debounce counters below. The
    /// active-entry stack and current root are thread-local (see `PerfLocalState`),
    /// so they need no lock.
    private let lock = NSLock()

    /// Root entries that have been completed. Shared across threads: `flush()`
    /// drains the whole pool so timings from command handling and background
    /// polling are reported together (this pooled-flush behavior is relied on).
    private var completedEntries: [MutablePerfEntry] = []

    // Debounce tracking (shared)
    private var debounceCount = 0
    private var lastDebounceTime: Int64?

    /// Per-thread active-entry state.
    ///
    /// The entry stack and current root are kept per-thread so that operations on
    /// one thread (e.g. background hierarchy polling on the main thread) never nest
    /// under an in-flight operation on another (e.g. command handling on the server
    /// queue). Sharing a single stack across threads mis-nested the timing tree and
    /// let `end()` pop another thread's entry (issue #3635). Completed roots are
    /// still moved into the shared `completedEntries` pool.
    private final class PerfLocalState {
        var entryStack: [MutablePerfEntry] = []
        var currentRoot: MutablePerfEntry?
    }

    private lazy var localStateKey = "com.ctrlproxy.perf.\(UInt(bitPattern: ObjectIdentifier(self).hashValue))"

    private func local() -> PerfLocalState {
        let dict = Thread.current.threadDictionary
        if let state = dict[localStateKey] as? PerfLocalState {
            return state
        }
        let state = PerfLocalState()
        dict[localStateKey] = state
        return state
    }

    /// Move a completed root entry into the shared pool.
    private func appendCompleted(_ entry: MutablePerfEntry) {
        lock.lock()
        completedEntries.append(entry)
        lock.unlock()
    }

    // MARK: - Init

    private init(timeProvider: TimeProvider = SystemTimeProvider()) {
        self.timeProvider = timeProvider
    }

    // MARK: - Serial/Parallel Blocks

    /// Start a serial block (operations run sequentially).
    public func serial(_ name: String) {
        let state = local()
        let now = timeProvider.currentTimeMillis()
        let entry = MutablePerfEntry(name: name, startTime: now, isParallel: false)

        if let parent = state.entryStack.last {
            parent.children.append(entry)
        } else {
            state.currentRoot = entry
        }
        state.entryStack.append(entry)
    }

    /// Start a new independent root block, ending any currently open blocks first.
    /// Use this for operations that may run concurrently and should be tracked as
    /// parallel/sibling entries rather than nested within each other.
    public func independentRoot(_ name: String) {
        let state = local()

        // End all open entries on this thread - they become completed siblings
        while !state.entryStack.isEmpty {
            endInternal(state)
        }

        // Start fresh root
        let now = timeProvider.currentTimeMillis()
        let entry = MutablePerfEntry(name: name, startTime: now, isParallel: false)
        state.currentRoot = entry
        state.entryStack.append(entry)
    }

    /// Start a parallel block (operations run concurrently).
    public func parallel(_ name: String) {
        let state = local()
        let now = timeProvider.currentTimeMillis()
        let entry = MutablePerfEntry(name: name, startTime: now, isParallel: true)

        if let parent = state.entryStack.last {
            parent.children.append(entry)
        } else {
            state.currentRoot = entry
        }
        state.entryStack.append(entry)
    }

    /// End the current block.
    public func end() {
        endInternal(local())
    }

    /// End the innermost open entry on the given thread-local state.
    private func endInternal(_ state: PerfLocalState) {
        let now = timeProvider.currentTimeMillis()

        guard let entry = state.entryStack.popLast() else {
            return
        }

        entry.endTime = now

        // If this was the root entry, move it into the shared completed pool.
        if state.entryStack.isEmpty, state.currentRoot === entry {
            state.currentRoot = nil
            appendCompleted(entry)
        }
    }

    // MARK: - Track Operations

    /// Track an operation with automatic start/end timing. Returns the result of the block.
    @discardableResult
    public func track<T>(_ name: String, block: () throws -> T) rethrows -> T {
        startOperation(name)
        defer { endOperation(name) }
        return try block()
    }

    /// Track an async operation with automatic start/end timing.
    @discardableResult
    public func trackAsync<T>(_ name: String, block: () async throws -> T) async rethrows -> T {
        startOperation(name)
        defer { endOperation(name) }
        return try await block()
    }

    /// Start tracking an operation manually.
    public func startOperation(_ name: String) {
        let state = local()
        let now = timeProvider.currentTimeMillis()
        let entry = MutablePerfEntry(name: name, startTime: now)

        if let parent = state.entryStack.last {
            parent.children.append(entry)
            state.entryStack.append(entry)
        } else {
            // No active block, this becomes a root entry
            state.currentRoot = entry
            state.entryStack.append(entry)
        }
    }

    /// End tracking an operation manually.
    public func endOperation(_ name: String) {
        let state = local()
        let now = timeProvider.currentTimeMillis()

        // Find the matching entry in this thread's stack
        guard let entry = state.entryStack.last, entry.name == name else {
            return
        }

        entry.endTime = now
        _ = state.entryStack.popLast()

        // If this was the root entry, move it into the shared completed pool.
        if state.entryStack.isEmpty, state.currentRoot === entry {
            state.currentRoot = nil
            appendCompleted(entry)
        }
    }

    // MARK: - Debounce Tracking

    /// Record a debounce event (when hierarchy updates are debounced).
    public func recordDebounce() {
        lock.lock()
        defer { lock.unlock() }

        debounceCount += 1
        lastDebounceTime = timeProvider.currentTimeMillis()

    }

    // MARK: - Flush and Query

    /// Flush all accumulated timing data and reset.
    /// Returns the timing data as an array for inclusion in WebSocket messages.
    public func flush() -> [PerfTiming]? {
        // End any incomplete entries on this thread (moves their roots into the
        // shared pool); done before taking the lock to avoid re-entrant locking.
        let state = local()
        while !state.entryStack.isEmpty {
            endInternal(state)
        }

        lock.lock()
        defer { lock.unlock() }

        // Collect all completed entries
        var entries: [PerfTiming] = []
        for entry in completedEntries {
            entries.append(entry.toTiming(timeProvider: timeProvider))
        }
        completedEntries.removeAll()

        // Include debounce info if any
        if debounceCount > 0 {
            let debounceInfo = PerfTiming(
                name: "debounce",
                durationMs: 0,
                children: [
                    PerfTiming.timing("count", durationMs: Int64(debounceCount)),
                    PerfTiming.timing("lastTime", durationMs: lastDebounceTime ?? 0),
                ]
            )
            entries.append(debounceInfo)
            debounceCount = 0
            lastDebounceTime = nil
        }

        return entries.isEmpty ? nil : entries
    }

    /// Get current timing data without clearing (for debugging).
    public func peek() -> [PerfTiming] {
        let state = local()
        var entries: [PerfTiming] = []

        // Include this thread's current root if any
        if let root = state.currentRoot {
            entries.append(root.toTiming(timeProvider: timeProvider))
        }

        // Include shared completed entries
        lock.lock()
        for entry in completedEntries {
            entries.append(entry.toTiming(timeProvider: timeProvider))
        }
        lock.unlock()

        return entries
    }

    /// Check if there's any accumulated timing data.
    public var hasData: Bool {
        let hasLocalRoot = local().currentRoot != nil
        lock.lock()
        defer { lock.unlock() }
        return !completedEntries.isEmpty || hasLocalRoot || debounceCount > 0
    }

    /// Clear all timing data without returning it.
    public func clear() {
        let state = local()
        state.entryStack.removeAll()
        state.currentRoot = nil

        lock.lock()
        completedEntries.removeAll()
        debounceCount = 0
        lastDebounceTime = nil
        lock.unlock()
    }
}
