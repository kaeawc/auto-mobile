import Foundation

/// Protocol for event broadcasting to allow faking in tests.
public protocol EventBroadcasting: Sendable {
    func broadcastBatch(bundleId: String?, events: [any SdkEvent])
}

/// Broadcasts SDK event batches via NotificationCenter for in-process communication
/// and HTTP POST to CtrlProxy for cross-process telemetry forwarding.
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

        let envelopes = events.compactMap { event -> SdkEventEnvelope? in
            try? SdkEventEnvelope(event)
        }
        guard !envelopes.isEmpty else { return }

        let batch = SdkEventBatch(
            bundleId: bundleId,
            events: envelopes
        )

        guard let data = try? JSONEncoder().encode(batch) else { return }

        // In-process notification
        NotificationCenter.default.post(
            name: Self.eventBatchNotification,
            object: nil,
            userInfo: [Self.eventBatchUserInfoKey: data]
        )

        #if DEBUG
        // HTTP POST to CtrlProxy for cross-process telemetry forwarding
        if let url = ctrlProxyUrl {
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.httpBody = data
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            NSLog("[AutoMobileSDK] Posting \(data.count) bytes to \(url.absoluteString)")
            urlSession.dataTask(with: request) { _, response, error in
                if let error = error {
                    NSLog("[AutoMobileSDK] SDK event POST failed: \(error.localizedDescription)")
                } else if let httpResponse = response as? HTTPURLResponse {
                    NSLog("[AutoMobileSDK] SDK event POST: \(httpResponse.statusCode), \(data.count) bytes")
                }
            }.resume()
        }
        #endif
    }
}
