import Foundation

/// Configuration for the AutoMobile SDK.
public struct AutoMobileConfiguration: Sendable {
    /// Maximum number of events to buffer before flushing.
    public let bufferSize: Int

    /// Interval in milliseconds between automatic flushes.
    public let flushIntervalMs: Int

    /// Maximum number of breadcrumbs to retain.
    public let maxBreadcrumbs: Int

    /// Session timeout in milliseconds.
    public let sessionTimeoutMs: Int

    /// Event processors run before events are buffered. Return nil to drop an event.
    public let eventProcessors: [any EventProcessing]

    /// Maximum number of pending events in the buffer before oldest events are dropped.
    public let maxPendingEvents: Int

    public init(
        bufferSize: Int = 50,
        flushIntervalMs: Int = 500,
        maxBreadcrumbs: Int = 100,
        sessionTimeoutMs: Int = 30_000,
        eventProcessors: [any EventProcessing] = [],
        maxPendingEvents: Int = 500
    ) {
        self.bufferSize = max(bufferSize, 1)
        self.flushIntervalMs = max(flushIntervalMs, 1)
        self.maxBreadcrumbs = max(maxBreadcrumbs, 1)
        self.sessionTimeoutMs = max(sessionTimeoutMs, 1)
        self.eventProcessors = eventProcessors
        self.maxPendingEvents = max(maxPendingEvents, 1)
    }

    /// A configuration with all default values.
    public static let `default` = AutoMobileConfiguration()
}
