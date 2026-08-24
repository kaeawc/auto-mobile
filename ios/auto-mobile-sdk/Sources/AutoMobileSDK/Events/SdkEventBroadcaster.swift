import Foundation

/// Protocol for event broadcasting to allow faking in tests.
protocol EventBroadcasting: Sendable {
    func broadcastBatch(bundleId: String?, events: [any SdkEvent])
}

/// Broadcasts SDK event batches via NotificationCenter for in-process communication
/// and HTTP POST to CtrlProxy for cross-process telemetry forwarding.
/// Supports disk-first persistence and retry with exponential backoff.
final class SdkEventBroadcaster: EventBroadcasting, @unchecked Sendable {

    static let eventBatchNotification = Notification.Name(
        "dev.jasonpearson.automobile.sdk.EVENT_BATCH"
    )

    static let eventBatchUserInfoKey = "eventBatch"

    static let shared = SdkEventBroadcaster()

    /// CtrlProxy HTTP endpoint for SDK event forwarding.
    /// Set by the SDK during initialization if CtrlProxy is detected.
    ///
    /// Read on the event buffer's flush thread (`broadcastBatch`/`deliverBatch`)
    /// and written from arbitrary threads (`setCtrlProxyUrl`), so all access is
    /// serialized by a lock — Optional/reference assignment is not atomic in
    /// Swift's memory model (issue #3632).
    /// Guards the cross-thread config references (`_ctrlProxyUrl`, `_persistence`),
    /// read on the event buffer's flush thread and the URLSession completion handler
    /// while written from arbitrary threads — Optional/reference assignment is not
    /// atomic in Swift's memory model (issue #3632).
    private let configLock = NSLock()
    private var _ctrlProxyUrl: URL?
    var ctrlProxyUrl: URL? {
        get {
            configLock.lock()
            defer { configLock.unlock() }
            return _ctrlProxyUrl
        }
        set {
            configLock.lock()
            defer { configLock.unlock() }
            _ctrlProxyUrl = newValue
        }
    }

    private let urlSession: URLSession

    /// Disk-first event persistence for reliable delivery. Same cross-thread access
    /// pattern as `ctrlProxyUrl`, so it is guarded by the same `configLock`.
    private var _persistence: (any EventPersisting)?
    var persistence: (any EventPersisting)? {
        get {
            configLock.lock()
            defer { configLock.unlock() }
            return _persistence
        }
        set {
            configLock.lock()
            let old = _persistence
            _persistence = newValue
            configLock.unlock()
            // Release the replaced persistence AFTER unlocking, in case its deinit
            // re-enters this lock (the non-recursive lock is not re-entrant).
            withExtendedLifetime(old) {}
        }
    }

    /// Retry policy for failed HTTP delivery. A `Sendable` value type that is never
    /// reassigned, so `let` makes cross-thread reads race-free with no lock.
    let retryPolicy = RetryPolicy()

    private init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 2
        config.timeoutIntervalForResource = 5
        config.waitsForConnectivity = false
        self.urlSession = URLSession(configuration: config)

        #if DEBUG
        // Default CtrlProxy port — only in debug builds
        _ctrlProxyUrl = URL(string: "http://localhost:8765/sdk-events")
        #else
        _ctrlProxyUrl = nil
        #endif
    }

    /// Test-only instance to exercise the broadcaster in isolation.
    static func makeTestInstance() -> SdkEventBroadcaster { SdkEventBroadcaster() }

    /// Configure the CtrlProxy endpoint URL. Pass nil to disable HTTP forwarding.
    /// No-op in release builds.
    func setCtrlProxyUrl(_ url: URL?) {
        #if DEBUG
        self.ctrlProxyUrl = url
        #endif
    }

    func broadcastBatch(bundleId: String?, events: [any SdkEvent]) {
        guard !events.isEmpty else { return }
        let sink = ctrlProxyUrl
        InternalLogger.debug("broadcastBatch called with \(events.count) events, ctrlProxyUrl=\(sink?.absoluteString ?? "nil")")

        // Persist to disk only when there is an asynchronous delivery sink whose
        // failure we must survive across a crash. Without a CtrlProxy URL the only
        // delivery is the synchronous in-process NotificationCenter post below, so
        // persisting would be a write-then-immediate-delete every flush — pure I/O
        // churn (issue #3636). CtrlProxy forwarding is DEBUG-only, so release builds
        // never persist.
        let batchId = sink != nil ? persistence?.persist(events) : nil

        deliverBatch(bundleId: bundleId, events: events, batchId: batchId)
    }

    /// Replay pending persisted batches (e.g., on startup after a crash).
    func replayPending(bundleId: String?) {
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
        InternalLogger.debug("Posting \(data.count) bytes to \(url.absoluteString) (attempt \(attempt))")
        urlSession.dataTask(with: request) { [weak self] _, response, error in
            guard let self = self else { return }
            let statusCode: Int
            if let httpResponse = response as? HTTPURLResponse {
                statusCode = httpResponse.statusCode
                InternalLogger.debug("SDK event POST: \(statusCode), \(data.count) bytes")
            } else if let error = error {
                statusCode = 0
                InternalLogger.debug("SDK event POST failed: \(error.localizedDescription)")
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
