@testable import AutoMobileSDK
import Foundation
import os

// MARK: - FakeTimer

final class FakeTimer: TimerScheduling, @unchecked Sendable {
    private let lock = NSLock()
    private var _block: (@Sendable () -> Void)?
    private var _intervalMs = 0
    private var _cancelled = false

    var intervalMs: Int {
        lock.lock()
        defer { lock.unlock() }
        return _intervalMs
    }

    var isCancelled: Bool {
        lock.lock()
        defer { lock.unlock() }
        return _cancelled
    }

    func schedule(intervalMs: Int, block: @escaping @Sendable () -> Void) {
        lock.lock()
        _intervalMs = intervalMs
        _block = block
        _cancelled = false
        lock.unlock()
    }

    func cancel() {
        lock.lock()
        _cancelled = true
        _block = nil
        lock.unlock()
    }

    /// Fire the timer manually for testing.
    func fire() {
        lock.lock()
        let block = _block
        lock.unlock()
        block?()
    }
}

// MARK: - FakeDateProvider

final class FakeDateProvider: DateProvider, @unchecked Sendable {
    private let lock = NSLock()
    private var _currentDate: Date

    init(initialDate: Date = Date(timeIntervalSince1970: 1_000_000)) {
        _currentDate = initialDate
    }

    func now() -> Date {
        lock.lock()
        defer { lock.unlock() }
        return _currentDate
    }

    func advance(by interval: TimeInterval) {
        lock.lock()
        _currentDate = _currentDate.addingTimeInterval(interval)
        lock.unlock()
    }

    func set(_ date: Date) {
        lock.lock()
        _currentDate = date
        lock.unlock()
    }
}

// MARK: - FakeDropCounter

final class FakeDropCounter: DropCounting, @unchecked Sendable {
    private let lock = NSLock()
    private var counts: [DropReason: Int] = [:]

    func increment(_ reason: DropReason) {
        lock.lock()
        counts[reason, default: 0] += 1
        lock.unlock()
    }

    func increment(_ reason: DropReason, count: Int) {
        lock.lock()
        counts[reason, default: 0] += count
        lock.unlock()
    }

    func snapshot() -> [DropReason: Int] {
        lock.lock()
        defer { lock.unlock() }
        return counts
    }

    func reset() {
        lock.lock()
        counts.removeAll()
        lock.unlock()
    }
}

// MARK: - FakeEventBuffer

final class FakeEventBuffer: EventBuffering, @unchecked Sendable {
    private let lock = NSLock()
    private var _events: [any SdkEvent] = []
    private var _started = false
    private var _stopped = false
    private var _shutdown = false
    private var _flushed = false
    private var _isBufferEnabled = true

    var events: [any SdkEvent] {
        lock.lock()
        defer { lock.unlock() }
        return _events
    }

    var isStarted: Bool {
        lock.lock()
        defer { lock.unlock() }
        return _started
    }

    var isShutdown: Bool {
        lock.lock()
        defer { lock.unlock() }
        return _shutdown
    }

    var wasFlushed: Bool {
        lock.lock()
        defer { lock.unlock() }
        return _flushed
    }

    var isStopped: Bool {
        lock.lock()
        defer { lock.unlock() }
        return _stopped
    }

    var isBufferEnabled: Bool {
        get {
            lock.lock()
            defer { lock.unlock() }
            return _isBufferEnabled
        }
        set {
            lock.lock()
            _isBufferEnabled = newValue
            lock.unlock()
        }
    }

    func add(_ event: any SdkEvent) {
        lock.lock()
        _events.append(event)
        lock.unlock()
    }

    func start() {
        lock.lock()
        _started = true
        lock.unlock()
    }

    func stop() {
        lock.lock()
        _stopped = true
        lock.unlock()
    }

    func shutdown() {
        lock.lock()
        _shutdown = true
        lock.unlock()
    }

    func flush() {
        lock.lock()
        _flushed = true
        lock.unlock()
    }
}

// MARK: - FakeEventProcessor

final class FakeEventProcessor: EventProcessing, @unchecked Sendable {
    private let handler: @Sendable (any SdkEvent) -> (any SdkEvent)?

    init(_ handler: @escaping @Sendable (any SdkEvent) -> (any SdkEvent)?) {
        self.handler = handler
    }

    func process(_ event: any SdkEvent) -> (any SdkEvent)? {
        handler(event)
    }
}

// MARK: - FakeNavigationListener

final class FakeNavigationListener: NavigationListener, @unchecked Sendable {
    private let lock = NSLock()
    private var _events: [NavigationEvent] = []

    var events: [NavigationEvent] {
        lock.lock()
        defer { lock.unlock() }
        return _events
    }

    func onNavigationEvent(_ event: NavigationEvent) {
        lock.lock()
        _events.append(event)
        lock.unlock()
    }
}

// MARK: - FakeUserDefaultsDriver

final class FakeUserDefaultsDriver: UserDefaultsDriver, @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [String: [String: (value: String?, type: KeyValueType)]] = [:]

    func getSuites() -> [UserDefaultsSuiteDescriptor] {
        lock.lock()
        defer { lock.unlock() }
        return storage.map { key, values in
            UserDefaultsSuiteDescriptor(name: key, displayName: key, entryCount: values.count)
        }
    }

    func getValues(suiteName: String?) -> [KeyValuePair] {
        lock.lock()
        defer { lock.unlock() }
        let key = suiteName ?? "standard"
        return (storage[key] ?? [:]).map { k, v in
            KeyValuePair(key: k, value: v.value, type: v.type)
        }.sorted { $0.key < $1.key }
    }

    func getValue(suiteName: String?, key: String) -> KeyValuePair? {
        lock.lock()
        defer { lock.unlock() }
        let suiteKey = suiteName ?? "standard"
        guard let entry = storage[suiteKey]?[key] else { return nil }
        return KeyValuePair(key: key, value: entry.value, type: entry.type)
    }

    func setValue(suiteName: String?, key: String, value: Any?, type: KeyValueType) {
        lock.lock()
        defer { lock.unlock() }
        let suiteKey = suiteName ?? "standard"
        if storage[suiteKey] == nil {
            storage[suiteKey] = [:]
        }
        storage[suiteKey]?[key] = (value: value.map { "\($0)" }, type: type)
    }

    func removeValue(suiteName: String?, key: String) {
        lock.lock()
        defer { lock.unlock() }
        let suiteKey = suiteName ?? "standard"
        storage[suiteKey]?.removeValue(forKey: key)
    }

    func clear(suiteName: String?) {
        lock.lock()
        defer { lock.unlock() }
        let suiteKey = suiteName ?? "standard"
        storage[suiteKey]?.removeAll()
    }
}

// MARK: - FakeDatabaseDriver

final class FakeDatabaseDriver: DatabaseDriver, @unchecked Sendable {
    var databases: [DatabaseDescriptor] = []
    var tables: [String: [String]] = [:]

    func getDatabases() -> [DatabaseDescriptor] { databases }
    func getTables(databasePath: String) -> [String] { tables[databasePath] ?? [] }

    func getTableData(databasePath _: String, table _: String, limit _: Int, offset _: Int) -> TableDataResult {
        TableDataResult(columns: [], rows: [], totalRows: 0)
    }

    func getTableStructure(databasePath _: String, table _: String) -> TableStructureResult {
        TableStructureResult(columns: [])
    }

    func executeSQL(databasePath _: String, query _: String) -> SQLExecutionResult {
        SQLExecutionResult(columns: nil, rows: nil, rowsAffected: 0)
    }
}

// MARK: - FakeSessionTracker

final class FakeSessionTracker: SessionTracking, @unchecked Sendable {
    private let lock = NSLock()
    private var _sessionId: String?
    var foregroundCount = 0
    var backgroundCount = 0

    func currentSessionId() -> String? {
        lock.lock()
        defer { lock.unlock() }
        return _sessionId
    }

    func onForeground() {
        lock.lock()
        foregroundCount += 1
        if _sessionId == nil { _sessionId = UUID().uuidString }
        lock.unlock()
    }

    func onBackground() {
        lock.lock()
        backgroundCount += 1
        lock.unlock()
    }

    func shutdown() {
        lock.lock()
        _sessionId = nil
        lock.unlock()
    }
}

// MARK: - FakeEventPersistence

final class FakeEventPersistence: EventPersisting, @unchecked Sendable {
    private let lock = NSLock()
    private var batches: [(String, [any SdkEvent])] = []
    private var _persistCallCount = 0
    private var _removeCallCount = 0
    private var _cleanupCallCount = 0

    var persistCallCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return _persistCallCount
    }

    var removeCallCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return _removeCallCount
    }

    var cleanupCallCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return _cleanupCallCount
    }

    var batchCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return batches.count
    }

    func persist(_ events: [any SdkEvent]) -> String? {
        let id = UUID().uuidString
        lock.lock()
        batches.append((id, events))
        _persistCallCount += 1
        lock.unlock()
        return id
    }

    func loadPending() -> [(batchId: String, events: [any SdkEvent])] {
        lock.lock()
        defer { lock.unlock() }
        return batches
    }

    func removeBatch(_ batchId: String) {
        lock.lock()
        batches.removeAll { $0.0 == batchId }
        _removeCallCount += 1
        lock.unlock()
    }

    func cleanup(maxAgeDays _: Int) {
        lock.lock()
        _cleanupCallCount += 1
        lock.unlock()
    }
}

// MARK: - FakeEventBroadcaster

final class FakeEventBroadcaster: EventBroadcasting, @unchecked Sendable {
    private let lock = NSLock()
    private var _batches: [(bundleId: String?, events: [any SdkEvent])] = []

    var batches: [(bundleId: String?, events: [any SdkEvent])] {
        lock.lock()
        defer { lock.unlock() }
        return _batches
    }

    func broadcastBatch(bundleId: String?, events: [any SdkEvent]) {
        lock.lock()
        _batches.append((bundleId: bundleId, events: events))
        lock.unlock()
    }
}

// MARK: - Event delivery fakes

final class ResolverResult: Sendable {
    private struct State: Sendable {
        var url: URL?
        var completed = false
    }

    private let lock = OSAllocatedUnfairLock(initialState: State())
    var url: URL? { lock.withLock { $0.url } }
    var completed: Bool { lock.withLock { $0.completed } }

    func set(_ url: URL?) {
        lock.withLock {
            $0.url = url
            $0.completed = true
        }
    }
}

final class FakeCtrlProxyHealthProbe: CtrlProxyHealthProbing, Sendable {
    private struct State: Sendable {
        var responses: [Int: CtrlProxyHealthResponse] = [:]
        var ports: [Int] = []
        var deferred = false
        var pending: [@Sendable () -> Void] = []
    }

    private let lock = OSAllocatedUnfairLock(initialState: State())
    var ports: [Int] { lock.withLock { $0.ports } }

    init(deferred: Bool = false) {
        lock.withLock { $0.deferred = deferred }
    }

    func completeNext() {
        let work = lock.withLock { $0.pending.isEmpty ? nil : $0.pending.removeFirst() }
        work?()
    }

    func respond(port: Int, deviceId: String?, statusCode: Int = 200) {
        let identity = deviceId.map { ",\"deviceId\":\"\($0)\"" } ?? ""
        let data = Data("{\"status\":\"ok\",\"port\":\(port)\(identity)}".utf8)
        setResponse(port: port, response: CtrlProxyHealthResponse(statusCode: statusCode, data: data))
    }

    func setResponse(port: Int, response: CtrlProxyHealthResponse?) {
        lock.withLock { $0.responses[port] = response }
    }

    func health(at url: URL, completion: @escaping @Sendable (CtrlProxyHealthResponse?) -> Void) {
        let work = lock.withLock { state -> (@Sendable () -> Void)? in
            let port = url.port ?? 0
            state.ports.append(port)
            let response = state.responses[port]
            let work: @Sendable () -> Void = { completion(response) }
            if state.deferred {
                state.pending.append(work)
                return nil
            }
            return work
        }
        work?()
    }
}

final class FakeEventDeliveryExecutor: Sendable {
    private let lock = OSAllocatedUnfairLock(initialState: [@Sendable () -> Void]())
    var count: Int { lock.withLock { $0.count } }

    func enqueue(_ work: @escaping @Sendable () -> Void) {
        lock.withLock { $0.append(work) }
    }

    func runNext() {
        let work = lock.withLock { $0.isEmpty ? nil : $0.removeFirst() }
        work?()
    }
}

final class FakeSdkEventTransport: SdkEventPosting, Sendable {
    private struct State: Sendable {
        var urls: [URL] = []
        var completions: [@Sendable (Int) -> Void] = []
    }

    private let lock = OSAllocatedUnfairLock(initialState: State())
    var urls: [URL] { lock.withLock { $0.urls } }

    func post(url: URL, data _: Data, completion: @escaping @Sendable (Int) -> Void) {
        lock.withLock {
            $0.urls.append(url)
            $0.completions.append(completion)
        }
    }

    func completeNext(statusCode: Int) {
        let completion = lock.withLock { $0.completions.isEmpty ? nil : $0.completions.removeFirst() }
        completion?(statusCode)
    }
}

// MARK: - FakeMainThreadExecutor

/// Models a background caller: work is recorded, never run until explicitly drained.
final class FakeMainThreadExecutor: MainThreadExecuting, Sendable {
    private let state = OSAllocatedUnfairLock(initialState: [@MainActor @Sendable () -> Void]())
    var pendingCount: Int { state.withLock { $0.count } }

    func execute(_ work: @escaping @MainActor @Sendable () -> Void) {
        state.withLock { $0.append(work) }
    }

    @MainActor
    func runNext() {
        let work = state.withLock { $0.isEmpty ? nil : $0.removeFirst() }
        work?()
    }

    /// Model an inline main-thread restart overtaking queued background teardown.
    @MainActor
    func runLast() {
        let work = state.withLock { $0.popLast() }
        work?()
    }

    @MainActor
    func runAll() {
        while pendingCount > 0 {
            runNext()
        }
    }
}
