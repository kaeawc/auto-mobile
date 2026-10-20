import Foundation
#if canImport(FoundationNetworking)
    import FoundationNetworking
#endif

struct PrototypeConnectionMetric: Sendable {
    var isNetworkLoad = true
    var isProxyConnection = false
    var remoteAddress: String?
    var remotePort: Int?
    var url: URL?
}

/// URLProtocol stubs do not produce network metrics. Tests supply snapshots explicitly;
/// the production provider never invents connection information when metrics are absent.
protocol PrototypeConnectionMetricsProviding: Sendable {
    func transactions(for metrics: URLSessionTaskMetrics?) -> [PrototypeConnectionMetric]
}

struct PrototypeConnectionMetrics: PrototypeConnectionMetricsProviding {
    func transactions(for metrics: URLSessionTaskMetrics?) -> [PrototypeConnectionMetric] {
        (metrics?.transactionMetrics ?? []).map {
            PrototypeConnectionMetric(
                isNetworkLoad: $0.resourceFetchType == .networkLoad,
                isProxyConnection: $0.isProxyConnection,
                remoteAddress: $0.remoteAddress,
                remotePort: $0.remotePort,
                url: $0.request.url
            )
        }
    }
}
