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

    /// Whether to initialize the crash reporting subsystem
    /// (`NSSetUncaughtExceptionHandler`). Set to `false` when the host app uses
    /// its own crash reporter (Sentry, Crashlytics, Bugsnag, etc.) to avoid
    /// duplicate handler installation.
    public let enableCrashReporting: Bool

    /// Whether to install signal handlers (SIGABRT, SIGSEGV, etc.) as part of
    /// crash reporting. Only relevant when `enableCrashReporting` is `true`.
    /// Defaults to `false` because signal handlers interfere with debuggers
    /// and test frameworks.
    public let enableSignalHandlers: Bool

    /// Whether to initialize network capture (`AutoMobileNetwork`). Set to
    /// `false` when the host app owns `URLProtocol` registration or uses
    /// another network inspector.
    public let enableNetworkCapture: Bool

    /// Whether to initialize hang detection (`AutoMobileHangs`). Set to
    /// `false` when the host app runs its own main-thread watchdog.
    public let enableHangDetection: Bool

    public init(
        bufferSize: Int = 50,
        flushIntervalMs: Int = 500,
        maxBreadcrumbs: Int = 100,
        sessionTimeoutMs: Int = 30_000,
        eventProcessors: [any EventProcessing] = [],
        maxPendingEvents: Int = 500,
        enableCrashReporting: Bool = true,
        enableSignalHandlers: Bool = false,
        enableNetworkCapture: Bool = true,
        enableHangDetection: Bool = true
    ) {
        self.bufferSize = max(bufferSize, 1)
        self.flushIntervalMs = max(flushIntervalMs, 1)
        self.maxBreadcrumbs = max(maxBreadcrumbs, 1)
        self.sessionTimeoutMs = max(sessionTimeoutMs, 1)
        self.eventProcessors = eventProcessors
        self.maxPendingEvents = max(maxPendingEvents, 1)
        self.enableCrashReporting = enableCrashReporting
        self.enableSignalHandlers = enableSignalHandlers
        self.enableNetworkCapture = enableNetworkCapture
        self.enableHangDetection = enableHangDetection
    }

    /// A configuration with all default values.
    public static let `default` = AutoMobileConfiguration()
}
