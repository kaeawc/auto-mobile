import Foundation
import OSLog

/// Reads logs from OSLogStore and serves them as SdkLogEvent-compatible JSON entries
/// via the GET /sdk-events endpoint. Polls every 500ms to capture new log entries.
///
/// Requires iOS 15+ for OSLogStore access.
@available(iOS 15.0, macOS 12.0, *)
public final class OSLogReader {
    private let lock = NSLock()
    private var timer: DispatchSourceTimer?
    private var lastEntryDate: Date
    private var buffer: [LogEntry] = []
    private let maxBufferSize = 500

    /// Lightweight struct matching the SdkLogEvent wire format.
    public struct LogEntry: Codable {
        public let eventType: String
        public let timestamp: Int64
        public let level: Int
        public let tag: String?
        public let message: String
    }

    public init() {
        self.lastEntryDate = Date()
    }

    // MARK: - Lifecycle

    public func start() {
        lock.lock()
        guard timer == nil else {
            lock.unlock()
            return
        }

        let source = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
        source.schedule(deadline: .now() + .milliseconds(500), repeating: .milliseconds(500))
        source.setEventHandler { [weak self] in
            self?.poll()
        }
        source.resume()
        timer = source
        lock.unlock()

        print("[OSLogReader] Started polling (500ms interval)")
    }

    public func stop() {
        lock.lock()
        timer?.cancel()
        timer = nil
        lock.unlock()
        print("[OSLogReader] Stopped")
    }

    /// Drain buffered log entries as SDK-batch-formatted JSON Data blobs.
    /// Each blob is a single batch: `{"bundleId":null,"events":[{"eventType":"log","payload":"<base64>"},...]}`.
    /// This matches the format expected by the TypeScript CtrlProxyClient parser.
    public func drain() -> [Data] {
        lock.lock()
        let entries = buffer
        buffer.removeAll()
        lock.unlock()

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

    private func poll() {
        do {
            let store = try OSLogStore(scope: .currentProcessIdentifier)
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

            lock.lock()
            lastEntryDate = latestDate
            if !newEntries.isEmpty {
                buffer.append(contentsOf: newEntries)
                if buffer.count > maxBufferSize {
                    buffer.removeFirst(buffer.count - maxBufferSize)
                }
            }
            lock.unlock()
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

/// Singleton holder for OSLogReader, used by WebSocketConnection to serve log entries.
@available(iOS 15.0, macOS 12.0, *)
public final class OSLogReaderHolder {
    public static let shared = OSLogReaderHolder()
    private let reader = OSLogReader()

    private init() {}

    public func start() { reader.start() }
    public func stop() { reader.stop() }
    public func drain() -> [Data] { reader.drain() }
}
