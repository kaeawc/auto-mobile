import Foundation
import OSLog

/// Reads logs from `OSLogStore` and serves them as `SdkLogEvent`-compatible JSON
/// batches via `GET /sdk-events`. Polls the process log store on an interval to capture
/// new entries. Ported from the reference `OSLogReader.swift`.
///
/// Rewrite archetype: QUEUE-CONFINEMENT. `final class … @unchecked Sendable` owning a
/// private serial `queue`; all mutable state (`timer`, `lastEntryDate`, `buffer`,
/// `store`) is confined to it and every on-queue method asserts
/// `dispatchPrecondition(.onQueue(queue))`. The `@unchecked` is justified by that
/// confinement. Queue-confinement (rather than the lock-confined `Sendable` archetype
/// used for `SdkEventBuffer`) is required here because `OSLogStore` is **not** `Sendable`
/// and so cannot be held in an `OSAllocatedUnfairLock<State: Sendable>`; a private serial
/// queue owns it without any per-field Sendable constraint.
///
/// The timer fires its handler on `queue`, so `poll()` runs on-queue and reads/writes the
/// confined state directly; the public `drain()` / `start()` / `stop()` funnel via
/// `queue.sync`. The package floor is iOS 17 / macOS 15, both above `OSLogStore`'s iOS 15
/// / macOS 12 requirement, so the reference's `@available(iOS 15.0, macOS 12.0, *)`
/// annotation is dropped — it is unconditionally available here.
public final class OSLogReader: @unchecked Sendable {
    /// How often to poll the process log store. Raised from 500ms to 1000ms (issue
    /// #5477): the previous cadence re-queried the whole log store twice a second for the
    /// entire session, loading the device even when idle.
    public static let pollIntervalMs = 1000

    /// Lightweight struct matching the SdkLogEvent wire format.
    public struct LogEntry: Codable, Sendable {
        public let eventType: String
        public let timestamp: Int64
        public let level: Int
        public let tag: String?
        public let message: String
    }

    private let queue = DispatchQueue(label: "com.ctrlproxy.oslogreader")

    // Queue-confined (accessed only on `queue`).
    private var timer: DispatchSourceTimer?
    private var lastEntryDate: Date
    private var buffer: [LogEntry] = []
    /// The single reused `OSLogStore` (the reference allocated a fresh store per poll;
    /// #5477). Created lazily on first poll, released on `stop()`.
    private var store: OSLogStore?

    private let maxBufferSize = 500
    private let storeFactory: @Sendable () throws -> OSLogStore

    public init(storeFactory: @escaping @Sendable () throws -> OSLogStore = {
        try OSLogStore(scope: .currentProcessIdentifier)
    }) {
        self.storeFactory = storeFactory
        lastEntryDate = Date()
    }

    // MARK: - Lifecycle

    public func start() {
        queue.sync { onqueue_start() }
    }

    private func onqueue_start() {
        dispatchPrecondition(condition: .onQueue(queue))
        guard timer == nil else { return }

        let interval = DispatchTimeInterval.milliseconds(Self.pollIntervalMs)
        // The timer fires its handler on `queue`, so `poll()` runs on-queue.
        let source = DispatchSource.makeTimerSource(queue: queue)
        source.schedule(deadline: .now() + interval, repeating: interval)
        source.setEventHandler { [weak self] in
            self?.poll()
        }
        source.resume()
        timer = source

        print("[OSLogReader] Started polling (\(Self.pollIntervalMs)ms interval)")
    }

    public func stop() {
        queue.sync { onqueue_stop() }
    }

    private func onqueue_stop() {
        dispatchPrecondition(condition: .onQueue(queue))
        timer?.cancel()
        timer = nil
        store = nil
        print("[OSLogReader] Stopped")
    }

    /// Drain buffered log entries as SDK-batch-formatted JSON Data blobs.
    /// Each blob is a single batch: `{"bundleId":null,"events":[{"eventType":"log","payload":"<base64>"},...]}`.
    /// This matches the format expected by the TypeScript CtrlProxyClient parser.
    public func drain() -> [Data] {
        let entries: [LogEntry] = queue.sync {
            let entries = buffer
            buffer.removeAll()
            return entries
        }

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

    // MARK: - Private

    /// Obtain the reused `OSLogStore`, lazily creating it on first use. Internal so
    /// `OSLogReaderParityTests` can assert the store is created once and reused. Safe to
    /// call off-queue; funnels through `queue.sync`.
    func obtainStore() throws -> OSLogStore {
        try queue.sync { try onqueue_obtainStore() }
    }

    /// The store is created on `queue`, so a single poll cadence never races itself.
    private func onqueue_obtainStore() throws -> OSLogStore {
        dispatchPrecondition(condition: .onQueue(queue))
        if let store {
            return store
        }
        let created = try storeFactory()
        store = created
        return created
    }

    /// Runs on `queue` (fired by the timer there). Reads/writes the confined state
    /// directly — it must never funnel back through the `queue.sync` wrappers, which
    /// would deadlock on the serial queue.
    private func poll() {
        dispatchPrecondition(condition: .onQueue(queue))
        do {
            let store = try onqueue_obtainStore()
            let position = store.position(date: lastEntryDate)
            let entries = try store.getEntries(at: position)

            var newEntries: [LogEntry] = []
            var latestDate = lastEntryDate

            for entry in entries {
                // Skip entries at or before our last-seen date to avoid duplicates
                guard entry.date > lastEntryDate else { continue }

                if let logEntry = entry as? OSLogEntryLog {
                    let level = Self.mapLevel(logEntry.level)
                    let tag = logEntry.subsystem.isEmpty ? nil : logEntry.subsystem
                    let message: String
                    if logEntry.category.isEmpty {
                        message = logEntry.composedMessage
                    } else {
                        message = "[\(logEntry.category)] \(logEntry.composedMessage)"
                    }

                    let logItem = LogEntry(
                        eventType: "log",
                        timestamp: Int64(logEntry.date.timeIntervalSince1970 * 1000),
                        level: level,
                        tag: tag,
                        message: message
                    )
                    newEntries.append(logItem)
                }

                if entry.date > latestDate {
                    latestDate = entry.date
                }
            }

            lastEntryDate = latestDate
            if !newEntries.isEmpty {
                buffer.append(contentsOf: newEntries)
                if buffer.count > maxBufferSize {
                    buffer.removeFirst(buffer.count - maxBufferSize)
                }
            }
        } catch {
            // OSLogStore may not be available in all contexts; silently skip
            print("[OSLogReader] Poll error: \(error.localizedDescription)")
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
