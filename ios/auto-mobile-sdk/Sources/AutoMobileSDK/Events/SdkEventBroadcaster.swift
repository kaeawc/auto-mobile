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

        // Default CtrlProxy port
        self.ctrlProxyUrl = URL(string: "http://localhost:8765/sdk-events")
    }

    /// Configure the CtrlProxy endpoint URL. Pass nil to disable HTTP forwarding.
    public func setCtrlProxyUrl(_ url: URL?) {
        self.ctrlProxyUrl = url
    }

    public func broadcastBatch(bundleId: String?, events: [any SdkEvent]) {
        guard !events.isEmpty else { return }

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

        // HTTP POST to CtrlProxy for cross-process telemetry forwarding
        if let url = ctrlProxyUrl {
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.httpBody = data
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            urlSession.dataTask(with: request) { _, response, error in
                if let error = error {
                    print("[AutoMobileSDK] SDK event POST failed: \(error.localizedDescription)")
                } else if let httpResponse = response as? HTTPURLResponse {
                    print("[AutoMobileSDK] SDK event POST: \(httpResponse.statusCode), \(data.count) bytes")
                }
            }.resume()
        }
    }
}
