import Foundation
import os

/// Protocol for persisting SDK event batches to disk for reliable delivery.
protocol EventPersisting: AnyObject, Sendable {
    /// Persist a batch of events. Returns a batch ID on success, nil on failure.
    func persist(_ events: [any SdkEvent]) -> String?
    /// Load all pending (unsent) batches in FIFO order.
    func loadPending() -> [(batchId: String, events: [any SdkEvent])]
    /// Remove a successfully delivered batch.
    func removeBatch(_ batchId: String)
    /// Remove batches older than maxAgeDays.
    /// Negative values are invalid and do nothing; zero removes batches strictly older than now.
    /// Large values are safe and do not overflow.
    func cleanup(maxAgeDays: Int)
}

/// On-disk representation of a single event: type discriminator + Codable payload bytes.
struct PersistedEvent: Codable, Sendable {
    let eventType: SdkEventType
    /// The JSON-encoded event payload (base64 when serialized via JSONEncoder since Data is Codable).
    let payload: Data
}

/// File-backed event persistence using JSON serialization.
final class FileEventPersistence: EventPersisting, Sendable {
    private let directory: URL
    private let lock = OSAllocatedUnfairLock<Void>()
    private let dateProvider: DateProvider
    private let maxPendingBatches: Int
    private let readData: @Sendable (URL) throws -> Data

    /// The pending batch count defaults to 100 and is clamped to at least one.
    init(
        directory: URL,
        dateProvider: DateProvider = SystemDateProvider(),
        maxPendingBatches: Int = 100,
        readData: @escaping @Sendable (URL) throws -> Data = { try Data(contentsOf: $0) }
    ) {
        self.directory = directory
        self.dateProvider = dateProvider
        self.readData = readData
        self.maxPendingBatches = max(1, maxPendingBatches)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        } catch {
            InternalLogger.warning("Event persistence directory creation failed: \(error.localizedDescription)")
        }
    }

    func persist(_ events: [any SdkEvent]) -> String? {
        guard !events.isEmpty else { return nil }
        let batchId = "\(Int(dateProvider.now().timeIntervalSince1970 * 1000))_\(UUID().uuidString)"
        let fileURL = directory.appendingPathComponent("events_\(batchId).json")

        // Reuse SdkEventEnvelope which already handles type-erased encoding
        let persisted: [PersistedEvent] = events.compactMap { event in
            guard let envelope = try? SdkEventEnvelope(event) else { return nil }
            return PersistedEvent(eventType: envelope.eventType, payload: envelope.payload)
        }
        guard !persisted.isEmpty else { return nil }

        return lock.withLock {
            guard let data = try? JSONEncoder().encode(persisted) else { return nil }
            do {
                try data.write(to: fileURL, options: .atomic)
                trimPending(keeping: fileURL.lastPathComponent)
                return batchId
            } catch {
                InternalLogger.warning("Event batch persistence failed: \(error.localizedDescription)")
                return nil
            }
        }
    }

    func loadPending() -> [(batchId: String, events: [any SdkEvent])] {
        lock.withLock {
            // Apply the cap before replay, including backlogs written by older SDKs.
            trimPending(keeping: nil)
            let files = orderedPendingFiles().suffix(maxPendingBatches)

            let decoder = JSONDecoder()
            return files.compactMap { fileURL in
                let data: Data
                do {
                    data = try readData(fileURL)
                } catch {
                    let readError = error as NSError
                    if readError.domain != NSCocoaErrorDomain || readError.code != NSFileReadNoSuchFileError {
                        InternalLogger.warning("Pending event batch read failed: \(error.localizedDescription)")
                    }
                    return nil
                }
                guard let persisted = try? decoder.decode([PersistedEvent].self, from: data) else {
                    try? FileManager.default.removeItem(at: fileURL) // corrupt file
                    return nil
                }
                let batchId = Self.extractBatchId(from: fileURL.lastPathComponent)

                let events: [any SdkEvent] = persisted.compactMap { entry in
                    decodeEvent(type: entry.eventType, data: entry.payload, decoder: decoder)
                }
                guard !events.isEmpty else { return nil }
                return (batchId, events)
            }
        }
    }

    func removeBatch(_ batchId: String) {
        lock.withLock {
            let fileURL = directory.appendingPathComponent("events_\(batchId).json")
            try? FileManager.default.removeItem(at: fileURL)
        }
    }

    /// Remove batches older than maxAgeDays.
    /// Negative values are invalid and do nothing; zero removes batches strictly older than now.
    /// Large values are safe and do not overflow.
    func cleanup(maxAgeDays: Int = 7) {
        guard maxAgeDays >= 0 else { return }
        lock.withLock {
            let cutoff = dateProvider.now().timeIntervalSince1970 * 1000 - Double(maxAgeDays) * 24 * 60 * 60 * 1000
            guard let files = try? FileManager.default.contentsOfDirectory(
                at: directory,
                includingPropertiesForKeys: nil
            )
            .filter({ $0.lastPathComponent.hasPrefix("events_") })
            else { return }

            for file in files {
                if let ts = Self.extractTimestamp(from: file.lastPathComponent), ts < cutoff {
                    try? FileManager.default.removeItem(at: file)
                }
            }
        }
    }

    // MARK: - Private

    /// Must be called under lock; shared ordering keeps eviction and replay consistent.
    private func orderedPendingFiles() -> [URL] {
        do {
            return try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
                .filter { $0.lastPathComponent.hasPrefix("events_") && $0.pathExtension == "json" }
                .sorted { first, second in
                    let firstTimestamp = Self.extractTimestamp(from: first.lastPathComponent) ?? 0
                    let secondTimestamp = Self.extractTimestamp(from: second.lastPathComponent) ?? 0
                    if firstTimestamp != secondTimestamp { return firstTimestamp < secondTimestamp }
                    return first.lastPathComponent < second.lastPathComponent
                }
        } catch {
            InternalLogger.warning("Pending event batch listing failed: \(error.localizedDescription)")
            return []
        }
    }

    private func trimPending(keeping justWrittenName: String?) {
        let files = orderedPendingFiles()
        var excess = files.count - maxPendingBatches
        for file in files where file.lastPathComponent != justWrittenName {
            guard excess > 0 else { break }
            do {
                try FileManager.default.removeItem(at: file)
                excess -= 1
            } catch {
                InternalLogger.warning("Pending event batch eviction failed: \(error.localizedDescription)")
            }
        }
    }

    private static func extractTimestamp(from filename: String) -> Double? {
        let batchId = extractBatchId(from: filename)
        return Double(batchId.split(separator: "_", maxSplits: 1, omittingEmptySubsequences: false).first ?? "")
    }

    private static func extractBatchId(from filename: String) -> String {
        var batchId = filename[...]
        if batchId.hasPrefix("events_") {
            batchId = batchId.dropFirst("events_".count)
        }
        if batchId.hasSuffix(".json") {
            batchId = batchId.dropLast(".json".count)
        }
        return String(batchId)
    }

    private func decodeEvent(type: SdkEventType, data: Data, decoder: JSONDecoder) -> (any SdkEvent)? {
        switch type {
        case .navigation:
            return try? decoder.decode(SdkNavigationEvent.self, from: data)
        case .handledException:
            return try? decoder.decode(SdkHandledExceptionEvent.self, from: data)
        case .crash:
            return try? decoder.decode(SdkCrashEvent.self, from: data)
        case .frameMetrics:
            return try? decoder.decode(SdkFrameMetricsEvent.self, from: data)
        case .hang:
            return try? decoder.decode(SdkHangEvent.self, from: data)
        case .networkRequest:
            return try? decoder.decode(SdkNetworkRequestEvent.self, from: data)
        case .webSocketFrame:
            return try? decoder.decode(SdkWebSocketFrameEvent.self, from: data)
        case .log:
            return try? decoder.decode(SdkLogEvent.self, from: data)
        case .lifecycle:
            return try? decoder.decode(SdkLifecycleEvent.self, from: data)
        case .notificationAction:
            return try? decoder.decode(SdkNotificationActionEvent.self, from: data)
        case .viewBodySnapshot:
            return try? decoder.decode(SdkViewBodySnapshotEvent.self, from: data)
        case .broadcast:
            return try? decoder.decode(SdkBroadcastEvent.self, from: data)
        case .interaction:
            return try? decoder.decode(SdkInteractionEvent.self, from: data)
        case .storageChanged:
            return try? decoder.decode(SdkStorageChangedEvent.self, from: data)
        case .viewHierarchy:
            return try? decoder.decode(SdkViewHierarchyEvent.self, from: data)
        case .webView:
            return try? decoder.decode(SdkWebViewEvent.self, from: data)
        }
    }
}
