import Foundation

/// Protocol for persisting SDK event batches to disk for reliable delivery.
protocol EventPersisting: AnyObject, Sendable {
    /// Persist a batch of events. Returns a batch ID on success, nil on failure.
    func persist(_ events: [any SdkEvent]) -> String?
    /// Load all pending (unsent) batches in FIFO order.
    func loadPending() -> [(batchId: String, events: [any SdkEvent])]
    /// Remove a successfully delivered batch.
    func removeBatch(_ batchId: String)
    /// Remove batches older than maxAgeDays.
    func cleanup(maxAgeDays: Int)
}

/// On-disk representation of a single event: type discriminator + Codable payload bytes.
struct PersistedEvent: Codable {
    let eventType: SdkEventType
    /// The JSON-encoded event payload (base64 when serialized via JSONEncoder since Data is Codable).
    let payload: Data
}

/// File-backed event persistence using JSON serialization.
final class FileEventPersistence: EventPersisting, @unchecked Sendable {
    private let directory: URL
    private let lock = NSLock()
    private let dateProvider: DateProvider

    init(directory: URL, dateProvider: DateProvider = SystemDateProvider()) {
        self.directory = directory
        self.dateProvider = dateProvider
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
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

        lock.lock()
        defer { lock.unlock() }
        guard let data = try? JSONEncoder().encode(persisted) else { return nil }
        do {
            try data.write(to: fileURL, options: .atomic)
            return batchId
        } catch {
            return nil
        }
    }

    func loadPending() -> [(batchId: String, events: [any SdkEvent])] {
        lock.lock()
        defer { lock.unlock() }

        guard let files = try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            .filter({ $0.lastPathComponent.hasPrefix("events_") && $0.pathExtension == "json" })
            .sorted(by: { file1, file2 in
                let ts1 = Self.extractTimestamp(from: file1.lastPathComponent) ?? 0
                let ts2 = Self.extractTimestamp(from: file2.lastPathComponent) ?? 0
                if ts1 != ts2 { return ts1 < ts2 }
                return file1.lastPathComponent < file2.lastPathComponent
            })
        else { return [] }

        let decoder = JSONDecoder()
        return files.compactMap { fileURL in
            guard let data = try? Data(contentsOf: fileURL),
                  let persisted = try? decoder.decode([PersistedEvent].self, from: data)
            else {
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

    func removeBatch(_ batchId: String) {
        lock.lock()
        defer { lock.unlock() }
        let fileURL = directory.appendingPathComponent("events_\(batchId).json")
        try? FileManager.default.removeItem(at: fileURL)
    }

    func cleanup(maxAgeDays: Int = 7) {
        lock.lock()
        defer { lock.unlock() }
        let cutoff = dateProvider.now().timeIntervalSince1970 * 1000 - Double(maxAgeDays * 24 * 60 * 60 * 1000)
        guard let files = try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            .filter({ $0.lastPathComponent.hasPrefix("events_") })
        else { return }

        for file in files {
            if let ts = Self.extractTimestamp(from: file.lastPathComponent), ts < cutoff {
                try? FileManager.default.removeItem(at: file)
            }
        }
    }

    // MARK: - Private

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
