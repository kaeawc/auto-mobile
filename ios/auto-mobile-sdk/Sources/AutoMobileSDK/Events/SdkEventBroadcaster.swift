import Foundation
import os

/// Protocol for event broadcasting to allow faking in tests.
protocol EventBroadcasting: Sendable {
    func broadcastBatch(bundleId: String?, events: [any SdkEvent])
}

protocol SdkEventPosting: Sendable {
    /// Status zero denotes transport failure rather than an HTTP response.
    func post(url: URL, data: Data, completion: @escaping @Sendable (Int) -> Void)
}

final class URLSessionSdkEventTransport: SdkEventPosting, Sendable {
    private let session: URLSession

    init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 2
        config.timeoutIntervalForResource = 5
        config.waitsForConnectivity = false
        session = URLSession(configuration: config)
    }

    func post(url: URL, data: Data, completion: @escaping @Sendable (Int) -> Void) {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpBody = data
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        session.dataTask(with: request) { _, response, error in
            if let error = error {
                InternalLogger.debug("SDK event POST failed: \(error.localizedDescription)")
                completion(0)
            } else {
                completion((response as? HTTPURLResponse)?.statusCode ?? 0)
            }
        }.resume()
    }
}

/// Broadcasts SDK event batches via NotificationCenter for in-process communication
/// and HTTP POST to CtrlProxy for cross-process telemetry forwarding.
/// Supports disk-first persistence and retry with exponential backoff.
final class SdkEventBroadcaster: EventBroadcasting, Sendable {
    private struct Configuration: Sendable {
        var ctrlProxyUrl: URL?
        var persistence: (any EventPersisting)?
        var discoveryEnabled: Bool
        var resolving = false
        var inFlightBatchIds: Set<String> = []
    }

    static let eventBatchNotification = Notification.Name(
        "dev.jasonpearson.automobile.sdk.EVENT_BATCH"
    )

    static let eventBatchUserInfoKey = "eventBatch"
    static let shared = SdkEventBroadcaster()

    /// All configuration and delivery bookkeeping crosses flush and completion
    /// threads, so it shares one lock (issue #3632). Never call injected code under it.
    private let configLock: OSAllocatedUnfairLock<Configuration>
    private let endpointResolver: any CtrlProxyEndpointResolving
    private let transport: any SdkEventPosting
    private let resolutionExecutor: @Sendable (@escaping @Sendable () -> Void) -> Void
    private let retryExecutor: @Sendable (TimeInterval, @escaping @Sendable () -> Void) -> Void

    /// An explicit assignment, including nil, disables simulator discovery.
    var ctrlProxyUrl: URL? {
        get { configLock.withLock { $0.ctrlProxyUrl } }
        set {
            #if DEBUG
                configLock.withLock {
                    $0.ctrlProxyUrl = newValue
                    $0.discoveryEnabled = false
                }
            #endif
        }
    }

    /// Disk-first event persistence for reliable delivery.
    var persistence: (any EventPersisting)? {
        get { configLock.withLock { $0.persistence } }
        set {
            let old = configLock.withLock { configuration in
                let old = configuration.persistence
                configuration.persistence = newValue
                return old
            }
            // Release AFTER unlocking, in case deinit re-enters this non-recursive lock.
            withExtendedLifetime(old) {}
        }
    }

    let retryPolicy = RetryPolicy()

    private init(
        endpointResolver: any CtrlProxyEndpointResolving = CtrlProxyEndpointResolver(),
        transport: any SdkEventPosting = URLSessionSdkEventTransport(),
        resolutionExecutor: @escaping @Sendable (@escaping @Sendable () -> Void) -> Void = {
            DispatchQueue.global().async(execute: $0)
        },
        retryExecutor: @escaping @Sendable (TimeInterval, @escaping @Sendable () -> Void) -> Void = { delay, work in
            DispatchQueue.global().asyncAfter(deadline: .now() + delay, execute: work)
        }
    ) {
        self.endpointResolver = endpointResolver
        self.transport = transport
        self.resolutionExecutor = resolutionExecutor
        self.retryExecutor = retryExecutor
        #if DEBUG
            let discoveryEnabled = endpointResolver.requiresSimulatorDiscovery
            let ctrlProxyUrl = discoveryEnabled ? nil : CtrlProxyEndpointResolver.defaultEndpoint
        #else
            let discoveryEnabled = false
            let ctrlProxyUrl: URL? = nil
        #endif
        configLock = OSAllocatedUnfairLock(initialState: Configuration(
            ctrlProxyUrl: ctrlProxyUrl, discoveryEnabled: discoveryEnabled
        ))
    }

    /// Test-only instance with deterministic transport, discovery, and scheduling seams.
    static func makeTestInstance(
        endpointResolver: any CtrlProxyEndpointResolving = CtrlProxyEndpointResolver(),
        transport: any SdkEventPosting = URLSessionSdkEventTransport(),
        resolutionExecutor: @escaping @Sendable (@escaping @Sendable () -> Void) -> Void = {
            DispatchQueue.global().async(execute: $0)
        },
        retryExecutor: @escaping @Sendable (TimeInterval, @escaping @Sendable () -> Void) -> Void = { delay, work in
            DispatchQueue.global().asyncAfter(deadline: .now() + delay, execute: work)
        }
    )
        -> SdkEventBroadcaster
    {
        SdkEventBroadcaster(
            endpointResolver: endpointResolver, transport: transport,
            resolutionExecutor: resolutionExecutor, retryExecutor: retryExecutor
        )
    }

    /// Configure the CtrlProxy endpoint URL. Pass nil to disable HTTP forwarding.
    /// No-op in release builds.
    func setCtrlProxyUrl(_ url: URL?) {
        ctrlProxyUrl = url
    }

    func broadcastBatch(bundleId: String?, events: [any SdkEvent]) {
        guard !events.isEmpty else { return }
        let configuration = configLock.withLock { $0 }
        // Discovery is an asynchronous sink even before its URL is known. Keep its
        // events on disk until the runner appears; explicit nil still avoids disk I/O.
        let shouldPersist = configuration.ctrlProxyUrl != nil || configuration.discoveryEnabled
        let batchId = shouldPersist ? configuration.persistence?.persist(events) : nil
        deliverBatch(bundleId: bundleId, events: events, batchId: batchId)
        resolveIfNeeded(bundleId: bundleId)
    }

    /// Replay pending persisted batches (e.g., on startup after a crash).
    func replayPending(bundleId: String?) {
        guard let persistence = persistence else { return }
        for (batchId, events) in persistence.loadPending() {
            deliverBatch(bundleId: bundleId, events: events, batchId: batchId)
        }
        resolveIfNeeded(bundleId: bundleId)
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
        NotificationCenter.default.post(
            name: Self.eventBatchNotification,
            object: nil,
            userInfo: [Self.eventBatchUserInfoKey: data]
        )

        #if DEBUG
            let delivery = configLock.withLock { configuration -> (url: URL?, keepPending: Bool) in
                guard let url = configuration.ctrlProxyUrl else {
                    return (nil, configuration.discoveryEnabled)
                }
                if let batchId = batchId, !configuration.inFlightBatchIds.insert(batchId).inserted {
                    return (nil, true)
                }
                return (url, true)
            }
            if let url = delivery.url {
                deliverWithRetry(url: url, data: data, batchId: batchId, attempt: 0)
            } else if !delivery.keepPending, let batchId = batchId {
                persistence?.removeBatch(batchId)
            }
        #else
            if let batchId = batchId { persistence?.removeBatch(batchId) }
        #endif
    }

    private func resolveIfNeeded(bundleId: String?) {
        #if DEBUG
            let shouldResolve = configLock.withLock { configuration in
                guard configuration.discoveryEnabled, configuration.ctrlProxyUrl == nil,
                      !configuration.resolving else { return false }
                configuration.resolving = true
                return true
            }
            guard shouldResolve else { return }
            resolutionExecutor { [weak self] in
                guard let self = self else { return }
                guard self.configLock.withLock({ $0.discoveryEnabled }) else {
                    self.configLock.withLock { $0.resolving = false }
                    return
                }
                self.endpointResolver.resolve { [weak self] url in
                    guard let self = self else { return }
                    let resolved = self.configLock.withLock { configuration in
                        configuration.resolving = false
                        guard configuration.discoveryEnabled, let url = url else { return false }
                        configuration.ctrlProxyUrl = url
                        return true
                    }
                    if resolved { self.replayPending(bundleId: bundleId) }
                }
            }
        #endif
    }

    #if DEBUG
        private func finishDelivery(batchId: String?) {
            if let batchId = batchId {
                _ = configLock.withLock { $0.inFlightBatchIds.remove(batchId) }
            }
        }

        private func deliverWithRetry(url: URL, data: Data, batchId: String?, attempt: Int) {
            guard ctrlProxyUrl == url else {
                finishDelivery(batchId: batchId)
                return
            }
            transport.post(url: url, data: data) { [weak self] statusCode in
                guard let self = self else { return }
                InternalLogger.debug("SDK event POST: \(statusCode), \(data.count) bytes")
                if statusCode >= 200, statusCode < 300 {
                    if let batchId = batchId { self.persistence?.removeBatch(batchId) }
                    self.finishDelivery(batchId: batchId)
                    return
                }
                let discoveredTransportFailure = self.configLock.withLock {
                    statusCode == 0 && $0.discoveryEnabled
                }
                if discoveredTransportFailure {
                    // Invalidate first: exposing an unresolved URL before clearing the
                    // resolver cache could let a concurrent flush reuse the stale port.
                    self.endpointResolver.invalidate(endpoint: url)
                    self.configLock.withLock { configuration in
                        if configuration.discoveryEnabled, configuration.ctrlProxyUrl == url {
                            configuration.ctrlProxyUrl = nil
                        }
                    }
                    self.finishDelivery(batchId: batchId)
                    // The next flush or replay discovers again, never retries the stale port.
                    return
                }
                let result = self.retryPolicy.shouldRetry(statusCode: statusCode, attempt: attempt)
                if result.shouldRetry {
                    self.retryExecutor(Double(result.delayMs) / 1000) { [weak self] in
                        self?.deliverWithRetry(url: url, data: data, batchId: batchId, attempt: attempt + 1)
                    }
                } else {
                    self.finishDelivery(batchId: batchId)
                    // Leave the batch on disk for a later replay.
                }
            }
        }
    #endif
}
