import Foundation

/// Protocol for event broadcasting to allow faking in tests.
public protocol EventBroadcasting: Sendable {
    func broadcastBatch(bundleId: String?, events: [any SdkEvent])
}

/// Broadcasts SDK event batches via NotificationCenter for in-process communication
/// and HTTP POST to CtrlProxy for cross-process telemetry forwarding.
/// Supports disk-first persistence and retry with exponential backoff.
public final class SdkEventBroadcaster: EventBroadcasting, @unchecked Sendable {

    public static let eventBatchNotification = Notification.Name(
        "dev.jasonpearson.automobile.sdk.EVENT_BATCH"
    )

    public static let eventBatchUserInfoKey = "eventBatch"

    public static let shared = SdkEventBroadcaster()

    /// CtrlProxy HTTP endpoint for SDK event forwarding.
    /// Set by the SDK during initialization if CtrlProxy is detected.
    private var ctrlProxyUrl: URL?
    private let urlSession: URLSession

    /// Disk-first event persistence for reliable delivery.
    public var persistence: (any EventPersisting)?

    /// Retry policy for failed HTTP delivery.
    public var retryPolicy: RetryPolicy = RetryPolicy()

    private init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 2
        config.timeoutIntervalForResource = 5
        config.waitsForConnectivity = false
        self.urlSession = URLSession(configuration: config)

        #if DEBUG
        // Default CtrlProxy port — only in debug builds
        self.ctrlProxyUrl = URL(string: "http://localhost:8765/sdk-events")
        #else
        self.ctrlProxyUrl = nil
        #endif
    }

    /// Configure the CtrlProxy endpoint URL. Pass nil to disable HTTP forwarding.
    /// No-op in release builds.
    public func setCtrlProxyUrl(_ url: URL?) {
        #if DEBUG
        self.ctrlProxyUrl = url
        #endif
    }

    public func broadcastBatch(bundleId: String?, events: [any SdkEvent]) {
        guard !events.isEmpty else { return }
        #if DEBUG
        NSLog("[AutoMobileSDK] broadcastBatch called with \(events.count) events, ctrlProxyUrl=\(ctrlProxyUrl?.absoluteString ?? "nil")")
        #endif

        // Persist to disk first for crash resilience
        let batchId = persistence?.persist(events)

        deliverBatch(bundleId: bundleId, events: events, batchId: batchId)
    }

    /// Replay pending persisted batches (e.g., on startup after a crash).
    public func replayPending(bundleId: String?) {
        guard let persistence = persistence else { return }
        for (batchId, events) in persistence.loadPending() {
            deliverBatch(bundleId: bundleId, events: events, batchId: batchId)
        }
    }

    // MARK: - Private

    private func deliverBatch(bundleId: String?, events: [any SdkEvent], batchId: String?) {
        let envelopes = events.compactMap { event -> SdkEventEnvelope? in
            try? SdkEventEnvelope(event)
        }
        guard !envelopes.isEmpty else {
            if let batchId = batchId { persistence?.removeBatch(batchId) }
            return
        }

        let batch = SdkEventBatch(bundleId: bundleId, events: envelopes)
        guard let data = try? JSONEncoder().encode(batch) else {
            if let batchId = batchId { persistence?.removeBatch(batchId) }
            return
        }

        // In-process notification
        NotificationCenter.default.post(
            name: Self.eventBatchNotification,
            object: nil,
            userInfo: [Self.eventBatchUserInfoKey: data]
        )

        #if DEBUG
        if let url = ctrlProxyUrl {
            deliverWithRetry(url: url, data: data, batchId: batchId, attempt: 0)
        } else if let batchId = batchId {
            persistence?.removeBatch(batchId)
        }
        #else
        if let batchId = batchId {
            persistence?.removeBatch(batchId)
        }
        #endif
    }

    #if DEBUG
    private func deliverWithRetry(url: URL, data: Data, batchId: String?, attempt: Int) {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpBody = data
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        NSLog("[AutoMobileSDK] Posting \(data.count) bytes to \(url.absoluteString) (attempt \(attempt))")
        urlSession.dataTask(with: request) { [weak self] _, response, error in
            guard let self = self else { return }
            let statusCode: Int
            if let httpResponse = response as? HTTPURLResponse {
                statusCode = httpResponse.statusCode
                NSLog("[AutoMobileSDK] SDK event POST: \(statusCode), \(data.count) bytes")
            } else if let error = error {
                statusCode = 0
                NSLog("[AutoMobileSDK] SDK event POST failed: \(error.localizedDescription)")
            } else {
                statusCode = 0
            }

            if statusCode >= 200 && statusCode < 300 {
                if let batchId = batchId {
                    self.persistence?.removeBatch(batchId)
                }
            } else {
                let result = self.retryPolicy.shouldRetry(statusCode: statusCode, attempt: attempt)
                if result.shouldRetry {
                    let delaySeconds = Double(result.delayMs) / 1000.0
                    DispatchQueue.global().asyncAfter(deadline: .now() + delaySeconds) { [weak self] in
                        self?.deliverWithRetry(url: url, data: data, batchId: batchId, attempt: attempt + 1)
                    }
                }
                // If no more retries, leave batch on disk for next app launch replay
            }
        }.resume()
    }
    #endif
}
