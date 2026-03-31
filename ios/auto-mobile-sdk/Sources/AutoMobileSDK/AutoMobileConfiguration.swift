import Foundation

/// Configuration for the AutoMobile SDK.
public struct AutoMobileConfiguration: Sendable {
    /// Maximum number of events to buffer before flushing.
    public var bufferSize: Int

    /// Interval in milliseconds between automatic flushes.
    public var flushIntervalMs: Int

    /// Maximum number of breadcrumbs to retain.
    public var maxBreadcrumbs: Int

    /// Session timeout in milliseconds.
    public var sessionTimeoutMs: Int

    public init(
        bufferSize: Int = 50,
        flushIntervalMs: Int = 500,
        maxBreadcrumbs: Int = 100,
        sessionTimeoutMs: Int = 30_000
    ) {
        self.bufferSize = bufferSize
        self.flushIntervalMs = flushIntervalMs
        self.maxBreadcrumbs = maxBreadcrumbs
        self.sessionTimeoutMs = sessionTimeoutMs
    }

    /// A configuration with all default values.
    public static let `default` = AutoMobileConfiguration()
}
