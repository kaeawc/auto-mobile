import Foundation
import os
import OSLog

struct OSLogReaderConfig: Sendable {
    let pollBaseMs: Int64 = 1000
    let pollMaxMs: Int64 = 8000
    let backoffFactor: Int64 = 2
    let idleWindowMs: Int64 = 45000
    let maxCatchUpLookbackMs: Int64 = 120_000
}

struct OSLogRecord: Sendable {
    let date: Date
    let level: Int
    let subsystem: String
    let category: String
    let composedMessage: String
}

protocol OSLogEntrySource: Sendable {
    func entries(since date: Date) throws -> [OSLogRecord]
    func reset()
}

/// Used only on the reader's serial queue; store creation and traversal stay there.
private final class StoreEntrySource: OSLogEntrySource, @unchecked Sendable {
    private let factory: @Sendable () throws -> OSLogStore
    private var store: OSLogStore?

    init(factory: @escaping @Sendable () throws -> OSLogStore) {
        self.factory = factory
    }

    func reset() { store = nil }

    func entries(since date: Date) throws -> [OSLogRecord] {
        let store: OSLogStore
        if let existing = self.store {
            store = existing
        } else {
            store = try factory()
            self.store = store
        }
        return try store.getEntries(at: store.position(date: date)).compactMap { entry in
            guard let log = entry as? OSLogEntryLog else { return nil }
            return OSLogRecord(
                date: log.date, level: OSLogReader.mapLevel(log.level),
                subsystem: log.subsystem, category: log.category, composedMessage: log.composedMessage
            )
        }
    }
}

protocol OSLogPollCancellation: Sendable {
    func cancel()
}

protocol OSLogPollScheduler: Sendable {
    func schedule(after milliseconds: Int64, callback: @escaping @Sendable () -> Void) -> any OSLogPollCancellation
}

private struct DispatchOSLogScheduler: OSLogPollScheduler {
    private final class Cancellation: OSLogPollCancellation, @unchecked Sendable {
        let timer: DispatchSourceTimer
        init(timer: DispatchSourceTimer) { self.timer = timer }
        func cancel() { timer.cancel() }
        deinit { timer.cancel() }
    }

    func schedule(after milliseconds: Int64, callback: @escaping @Sendable () -> Void) -> any OSLogPollCancellation {
        let timer = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
        timer.schedule(deadline: .now() + .milliseconds(Int(milliseconds)))
        timer.setEventHandler(handler: callback)
        timer.resume()
        return Cancellation(timer: timer)
    }
}

public final class OSLogReader: @unchecked Sendable {
    /// Lightweight struct matching the SdkLogEvent wire format.
    public struct LogEntry: Codable, Sendable {
        public let eventType: String
        public let timestamp: Int64
        public let level: Int
        public let tag: String?
        public let message: String
    }

    private let queue: DispatchQueue
    private let completedEntries = OSAllocatedUnfairLock<[LogEntry]>(initialState: [])

    private let source: any OSLogEntrySource
    private let clock: any ProxyTimer
    private let scheduler: any OSLogPollScheduler
    private let config: OSLogReaderConfig
    private let maxBufferSize = 500

    // Queue-confined (accessed only on `queue`).
    private var scheduledPoll: (any OSLogPollCancellation)?
    private var armed = false
    private var polling = false
    private var generation = 0
    private var nextDelayMs: Int64
    private var lastEntryDate: Date
    private var lastDrainDate: Date?

    public convenience init(storeFactory: @escaping @Sendable () throws -> OSLogStore = {
        try OSLogStore(scope: .currentProcessIdentifier)
    }) {
        self.init(queue: DispatchQueue(label: "com.ctrlproxy.oslogreader"), storeFactory: storeFactory)
    }

    convenience init(queue: DispatchQueue, storeFactory: @escaping @Sendable () throws -> OSLogStore) {
        self.init(queue: queue, source: StoreEntrySource(factory: storeFactory))
    }

    init(
        queue: DispatchQueue,
        source: any OSLogEntrySource,
        clock: any ProxyTimer = SystemTimer(),
        scheduler: any OSLogPollScheduler = DispatchOSLogScheduler(),
        config: OSLogReaderConfig = OSLogReaderConfig()
    ) {
        self.queue = queue
        self.source = source
        self.clock = clock
        self.scheduler = scheduler
        self.config = config
        nextDelayMs = config.pollBaseMs
        lastEntryDate = Date(timeIntervalSince1970: Double(clock.now()) / 1000)
    }

    // MARK: - Lifecycle

    public func start() {
        queue.sync { armed = true }
    }

    public func stop() {
        queue.sync {
            armed = false
            lastDrainDate = nil
            endPollingSession()
        }
    }

    private func onqueue_drain() {
        dispatchPrecondition(condition: .onQueue(queue))
        lastDrainDate = Date(timeIntervalSince1970: Double(clock.now()) / 1000)
        guard armed, !polling else { return }
        polling = true
        nextDelayMs = config.pollBaseMs
        // Catch-up is immediate; active drains extend demand without changing backoff.
        poll(isCatchUp: true)
    }

    /// Drain buffered log entries as SDK-batch-formatted JSON Data blobs.
    /// Each blob is a single batch: `{"bundleId":null,"events":[{"eventType":"log","payload":"<base64>"},...]}`.
    /// This matches the format expected by the TypeScript CtrlProxyClient parser.
    public func drain() -> [Data] {
        let entries = completedEntries.withLock { buffer in
            let entries = buffer
            buffer.removeAll(keepingCapacity: true)
            return entries
        }
        // Wake after taking the buffer so entries a woken poll appends reach the next drain, never this one.
        queue.async { [weak self] in self?.onqueue_drain() }

        guard !entries.isEmpty else { return [] }

        let encoder = JSONEncoder()
        let envelopes: [[String: Any]] = entries.compactMap { entry in
            guard let payloadData = try? encoder.encode(entry) else { return nil }
            let payloadBase64 = payloadData.base64EncodedString()
            return ["eventType": entry.eventType, "payload": payloadBase64]
        }

        let batch: [String: Any] = [
            "bundleId": NSNull(),
            "events": envelopes,
        ]

        guard let batchData = try? JSONSerialization.data(withJSONObject: batch) else { return [] }
        return [batchData]
    }

    /// Publish only completed traversal results; drains never wait for the polling queue.
    func appendCompletedEntries(_ entries: [LogEntry]) {
        completedEntries.withLock {
            $0.append(contentsOf: entries, enforcingMaximumSize: maxBufferSize)
        }
    }

    // MARK: - Private

    private func endPollingSession() {
        polling = false
        generation += 1
        scheduledPoll?.cancel()
        scheduledPoll = nil
        nextDelayMs = config.pollBaseMs
        source.reset()
    }

    private func endSessionIfIdle() -> Bool {
        let now = Date(timeIntervalSince1970: Double(clock.now()) / 1000)
        guard let lastDrainDate,
              now.timeIntervalSince(lastDrainDate) <= Double(config.idleWindowMs) / 1000
        else {
            endPollingSession()
            return true
        }
        return false
    }

    private func poll(isCatchUp: Bool = false) {
        dispatchPrecondition(condition: .onQueue(queue))
        guard armed, polling else { return }
        scheduledPoll?.cancel()
        scheduledPoll = nil
        guard !endSessionIfIdle() else { return }
        let now = Date(timeIntervalSince1970: Double(clock.now()) / 1000)
        let cursor = max(lastEntryDate, now.addingTimeInterval(-Double(config.maxCatchUpLookbackMs) / 1000))
        var newEntries: [LogEntry] = []
        do {
            let records = try source.entries(since: cursor)
            for record in records where record.date > cursor {
                newEntries.append(LogEntry(
                    eventType: "log",
                    timestamp: Int64(record.date.timeIntervalSince1970 * 1000),
                    level: record.level,
                    tag: record.subsystem.isEmpty ? nil : record.subsystem,
                    message: record.category.isEmpty
                        ? record.composedMessage : "[\(record.category)] \(record.composedMessage)"
                ))
                lastEntryDate = max(lastEntryDate, record.date)
            }
            appendCompletedEntries(newEntries)
        } catch {
            print("[OSLogReader] Poll error: \(error.localizedDescription)")
        }

        // A traversal can outlast consumer demand, even when it returns new records.
        guard !endSessionIfIdle() else { return }
        if !newEntries.isEmpty {
            nextDelayMs = config.pollBaseMs
        } else if !isCatchUp {
            nextDelayMs = min(nextDelayMs * config.backoffFactor, config.pollMaxMs)
        }

        let scheduledGeneration = generation
        scheduledPoll = scheduler.schedule(after: nextDelayMs) { [weak self] in
            guard let self else { return }
            queue.async { [weak self] in
                guard let self, generation == scheduledGeneration else { return }
                poll()
            }
        }
    }

    /// Map `OSLogEntryLog.Level` to the AutoMobile SDK's `LogLevel` scale
    /// (`verbose=0, debug=1, info=2, warning=3, error=4, fault=5`), the same scale
    /// `SdkLogEvent.level` uses. OSLog entries are served on the SDK-events endpoint
    /// alongside SDK log events and share one numeric scale downstream, so they must
    /// use the SDK scale — not an Android-style one — or the desktop Logs facet
    /// mis-buckets them (issue #4847). OSLog has no "warning" severity, so `.notice`
    /// (its default level) folds into `info`.
    /// - `.debug`  -> 1 (debug)
    /// - `.info`   -> 2 (info)
    /// - `.notice` -> 2 (info)
    /// - `.error`  -> 4 (error)
    /// - `.fault`  -> 5 (fault)
    /// - `.undefined` / unknown -> 2 (info)
    static func mapLevel(_ level: OSLogEntryLog.Level) -> Int {
        switch level {
        case .undefined:
            return 2
        case .debug:
            return 1
        case .info:
            return 2
        case .notice:
            return 2
        case .error:
            return 4
        case .fault:
            return 5
        @unknown default:
            return 2
        }
    }
}
