import Foundation

/// Fine-grained DI surface for the SDK's network subsystem.
public protocol AutoMobileNetworkAPI: AnyObject, Sendable {
    func recordRequest(_ record: NetworkRequestRecord)
    func captureRecorder() -> NetworkCaptureRecorder
    func setCaptureHeaders(_ enabled: Bool)
    func setCaptureBodies(_ enabled: Bool)
}

/// Default implementation of `AutoMobileNetworkAPI` backed by `AutoMobileNetwork.shared`.
public final class DefaultAutoMobileNetworkAPI: AutoMobileNetworkAPI, @unchecked Sendable {
    private let network = AutoMobileNetwork.shared

    public init() {}

    public func recordRequest(_ record: NetworkRequestRecord) {
        network.recordRequest(record)
    }

    public func captureRecorder() -> NetworkCaptureRecorder {
        network.captureRecorder()
    }

    public func setCaptureHeaders(_ enabled: Bool) {
        network.setCaptureHeaders(enabled)
    }

    public func setCaptureBodies(_ enabled: Bool) {
        network.setCaptureBodies(enabled)
    }
}
