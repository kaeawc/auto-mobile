import Foundation
#if canImport(UIKit)
import UIKit
#endif

/// Main entry point for the AutoMobile iOS SDK.
/// Provides navigation event tracking, log filtering, network monitoring,
/// crash detection, and more.
public final class AutoMobileSDK: @unchecked Sendable {
    public static let shared = AutoMobileSDK()
    private static let sessionEpochDefaultsKey = "com.kaeawc.auto-mobile.sdk.session-epoch"

    private let lock = NSLock()
    private var listeners: [NavigationListener] = []
    private var _isEnabled = true
    private var _isInitialized = false
    private var _bundleId: String?
    private var _sdkContext: SdkContext?
    private var _configuration: AutoMobileConfiguration?
    private var eventBuffer: SdkEventBuffer?
    private var navigationSequenceNumber: Int64 = 0
    private var sdkSessionId: String?
    private var sdkSessionEpoch: Int64?
    private var trackingGeneration: Int64 = 0
    private var _dropCounter: DefaultDropCounter?
    private var eventPersistence: (any EventPersisting)?
    private var sessionTracker: SessionTracker?
    private var sessionObservers: [NSObjectProtocol] = []
    private var _breadcrumbTrail: BreadcrumbTrail?

    private init() {}

    // MARK: - Initialization

    /// Initialize the SDK with all subsystems using default configuration.
    /// Call this early in your app lifecycle (e.g., in your App init or AppDelegate).
    public func initialize(bundleId: String? = nil) {
        initialize(bundleId: bundleId, configuration: .default)
    }

    /// Initialize the SDK with all subsystems using a custom configuration.
    /// Call this early in your app lifecycle (e.g., in your App init or AppDelegate).
    public func initialize(bundleId: String? = nil, configuration: AutoMobileConfiguration) {
        lock.lock()
        guard !_isInitialized else {
            lock.unlock()
            return
        }
        _isInitialized = true

        let context = SdkContext()
        context.appVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String
        _sdkContext = context

        let resolvedBundleId = bundleId ?? Bundle.main.bundleIdentifier
        _bundleId = resolvedBundleId
        let newSessionId = UUID().uuidString
        let newSessionEpoch = Self.nextSessionEpoch()
        sdkSessionId = newSessionId
        sdkSessionEpoch = newSessionEpoch
        trackingGeneration = 0
        _configuration = configuration

        let counter = DefaultDropCounter()
        _dropCounter = counter

        let dateProvider: DateProvider = SystemDateProvider()

        // Set up disk-first event persistence
        let persistence: any EventPersisting
        if let cachesDir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first {
            let eventsDir = cachesDir.appendingPathComponent("automobile_events")
            persistence = FileEventPersistence(directory: eventsDir, dateProvider: dateProvider)
        } else {
            let tmpDir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("automobile_events")
            persistence = FileEventPersistence(directory: tmpDir, dateProvider: dateProvider)
        }
        self.eventPersistence = persistence
        SdkEventBroadcaster.shared.persistence = persistence

        // Cache device info while on main thread
        AutoMobileFailures.shared.cacheDeviceInfo()

        let buffer = SdkEventBuffer(
            maxBufferSize: configuration.bufferSize,
            flushIntervalMs: configuration.flushIntervalMs,
            maxPendingEvents: configuration.maxPendingEvents,
            processors: configuration.eventProcessors,
            dropCounter: counter
        ) { [weak self] events in
            let bundleId = self?.bundleId
            SdkEventBroadcaster.shared.broadcastBatch(bundleId: bundleId, events: events)
        }
        self.eventBuffer = buffer
        lock.unlock()

        buffer.start()
        SdkEventBroadcaster.shared.broadcastBatch(
            bundleId: resolvedBundleId,
            events: [SdkLifecycleEvent(state: "sdk_session_started", bundleId: resolvedBundleId, sessionId: newSessionId, sessionEpoch: newSessionEpoch, trackingGeneration: 0)]
        )

        // Replay any pending batches from previous sessions and clean up old ones
        persistence.cleanup(maxAgeDays: 7)
        SdkEventBroadcaster.shared.replayPending(bundleId: resolvedBundleId)

        // Initialize subsystems
        AutoMobileLog.shared.initialize(bundleId: resolvedBundleId, buffer: buffer)
        if configuration.enableNetworkCapture {
            AutoMobileNetwork.shared.initialize(bundleId: resolvedBundleId, buffer: buffer)
        }
        AutoMobileFailures.shared.initialize(bundleId: resolvedBundleId, buffer: buffer)
        let trail = BreadcrumbTrail(maxSize: configuration.maxBreadcrumbs)
        lock.lock()
        _breadcrumbTrail = trail
        lock.unlock()

        if configuration.enableCrashReporting {
            AutoMobileCrashes.shared.initialize(bundleId: resolvedBundleId, buffer: buffer)
            if configuration.enableSignalHandlers {
                AutoMobileCrashes.shared.enableSignalHandlers()
            }
        }
        if configuration.enableHangDetection {
            AutoMobileHangs.shared.initialize(bundleId: resolvedBundleId, buffer: buffer)
            AutoMobileHangs.shared.startMonitoring()
        }
        AutoMobileOsEvents.shared.initialize(bundleId: resolvedBundleId, buffer: buffer)
        AutoMobileNotificationObserver.shared.initialize(bundleId: resolvedBundleId, buffer: buffer)
        AutoMobileInteractionTracker.shared.initialize(bundleId: resolvedBundleId, buffer: buffer)
        ViewBodyTracker.shared.initialize(buffer: buffer, dateProvider: dateProvider)
        #if canImport(UIKit) && !os(watchOS)
        ViewHierarchyTracker.shared.initialize(buffer: buffer)
        #endif
        UserDefaultsInspector.shared.initialize(buffer: buffer)
        DatabaseInspector.shared.initialize()

        // Start navigation adapter
        SwiftUINavigationAdapter.shared.start()

        // Session tracking
        let tracker = SessionTracker()
        lock.lock()
        self.sessionTracker = tracker
        lock.unlock()

        #if canImport(UIKit) && !os(watchOS)
        let fgObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification,
            object: nil,
            queue: .main
        ) { [weak tracker] _ in
            tracker?.onForeground()
        }
        let bgObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification,
            object: nil,
            queue: .main
        ) { [weak tracker] _ in
            tracker?.onBackground()
        }
        lock.lock()
        sessionObservers.append(contentsOf: [fgObserver, bgObserver])
        lock.unlock()
        #endif
    }

    // MARK: - Navigation Listeners

    /// Register a navigation event listener.
    public func addNavigationListener(_ listener: NavigationListener) {
        lock.lock()
        defer { lock.unlock() }
        listeners.append(listener)
    }

    /// Convenience: register a closure-based listener.
    @discardableResult
    public func addNavigationListener(_ block: @escaping @Sendable (NavigationEvent) -> Void) -> NavigationListener {
        let listener = BlockNavigationListener(block)
        addNavigationListener(listener)
        return listener
    }

    /// Remove a navigation event listener.
    public func removeNavigationListener(_ listener: NavigationListener) {
        lock.lock()
        defer { lock.unlock() }
        listeners.removeAll { $0 === listener }
    }

    /// Remove all navigation listeners.
    public func clearNavigationListeners() {
        lock.lock()
        defer { lock.unlock() }
        listeners.removeAll()
    }

    /// Notify all registered listeners of a navigation event.
    public func notifyNavigationEvent(_ event: NavigationEvent) {
        guard isEnabled else { return }

        lock.lock()
        let currentListeners = listeners
        navigationSequenceNumber += 1
        let sequenceNumber = navigationSequenceNumber
        let currentSessionId = sdkSessionId
        let currentSessionEpoch = sdkSessionEpoch
        let currentTrackingGeneration = trackingGeneration
        lock.unlock()

        for listener in currentListeners {
            listener.onNavigationEvent(event)
        }

        // Buffer as SDK event
        let sdkEvent = SdkNavigationEvent(
            timestamp: event.timestamp,
            sequenceNumber: sequenceNumber,
            sessionId: currentSessionId,
            sessionEpoch: currentSessionEpoch,
            trackingGeneration: currentTrackingGeneration,
            destination: event.destination,
            source: NavigationSourceType(rawValue: event.source.rawValue) ?? .custom,
            arguments: event.arguments,
            metadata: event.metadata
        )
        eventBuffer?.add(sdkEvent)
        // Navigation is control-plane state for observe/diff, not bulk telemetry.
        // Flush it immediately so a post-action observation can fetch the current
        // screen identity instead of waiting for the regular telemetry cadence.
        eventBuffer?.flush()
    }

    public func recordWebViewEvent(_ event: SdkWebViewEvent) {
        guard isEnabled else { return }
        eventBuffer?.add(event)
    }

    /// Number of registered listeners.
    public var listenerCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return listeners.count
    }

    // MARK: - Session

    /// Returns the current session ID, or nil if no session is active.
    public func currentSessionId() -> String? {
        return sessionTracker?.currentSessionId()
    }

    // MARK: - Breadcrumbs

    /// Add a breadcrumb to the trail. Breadcrumbs are attached to crash reports
    /// so that recent app activity is visible when diagnosing crashes.
    ///
    /// - Parameters:
    ///   - message: A short description of the breadcrumb.
    ///   - category: The category (defaults to `.custom`).
    ///   - metadata: Optional key-value metadata.
    public func addBreadcrumb(
        message: String,
        category: BreadcrumbCategory = .custom,
        metadata: [String: String] = [:]
    ) {
        lock.lock()
        let trail = _breadcrumbTrail
        lock.unlock()

        trail?.add(Breadcrumb(
            category: category,
            message: message,
            metadata: metadata
        ))
    }

    // MARK: - Shutdown

    /// Shuts down the SDK, releasing all resources.
    /// After calling this method, `initialize` may be called again to restart the SDK.
    public func shutdown() {
        lock.lock()
        let config = _configuration
        lock.unlock()

        // Reset all subsystems in reverse initialization order. Skip any
        // subsystem that was never initialized (per configuration flags) so
        // shutdown() does not clobber host-app handlers we never replaced.
        SwiftUINavigationAdapter.shared.stop()
        if config?.enableCrashReporting ?? true {
            AutoMobileCrashes.shared.reset()
        }
        if config?.enableHangDetection ?? true {
            AutoMobileHangs.shared.reset()
        }
        AutoMobileOsEvents.shared.reset()
        AutoMobileNotificationObserver.shared.reset()
        AutoMobileInteractionTracker.shared.reset()
        ViewBodyTracker.shared.reset()
        #if canImport(UIKit) && !os(watchOS)
        ViewHierarchyTracker.shared.reset()
        #endif
        UserDefaultsInspector.shared.reset()
        DatabaseInspector.shared.reset()
        if config?.enableNetworkCapture ?? true {
            AutoMobileNetwork.shared.reset()
        }
        AutoMobileFailures.shared.reset()
        AutoMobileBiometrics.shared.reset()
        AutoMobileLog.shared.reset()

        // Shut down session tracker and remove observers
        lock.lock()
        let trackerToShutdown = sessionTracker
        sessionTracker = nil
        let observersToRemove = sessionObservers
        sessionObservers.removeAll()
        lock.unlock()

        trackerToShutdown?.shutdown()
        for observer in observersToRemove {
            NotificationCenter.default.removeObserver(observer)
        }

        // Extract buffer under lock, then shut it down OUTSIDE the lock
        // to prevent deadlock: shutdown() -> onFlush -> bundleId -> lock
        lock.lock()
        let bufferToShutdown = eventBuffer
        _sdkContext = nil
        eventBuffer = nil
        _dropCounter = nil
        _breadcrumbTrail?.clear()
        _breadcrumbTrail = nil
        eventPersistence = nil
        SdkEventBroadcaster.shared.persistence = nil
        listeners.removeAll()
        _isEnabled = true
        _isInitialized = false
        _bundleId = nil
        _configuration = nil
        navigationSequenceNumber = 0
        sdkSessionId = nil
        sdkSessionEpoch = nil
        trackingGeneration = 0
        lock.unlock()

        bufferToShutdown?.shutdown()
    }

    // MARK: - Enable/Disable

    /// Whether the SDK is enabled for tracking.
    public var isEnabled: Bool {
        lock.lock()
        defer { lock.unlock() }
        return _isEnabled
    }

    /// Enable or disable the SDK.
    /// When disabled, the event buffer stops accepting events, its flush timer is cancelled,
    /// and all subsystems (hang detection, OS events, interaction tracking, network, notifications)
    /// are paused. When re-enabled, subsystems resume.
    public func setEnabled(_ enabled: Bool) {
        lock.lock()
        let wasEnabled = _isEnabled
        if wasEnabled != enabled {
            trackingGeneration += 1
        }
        _isEnabled = enabled
        let buffer = eventBuffer
        let initialized = _isInitialized
        let config = _configuration
        let bundleId = _bundleId
        let currentSessionId = sdkSessionId
        let currentSessionEpoch = sdkSessionEpoch
        let currentTrackingGeneration = trackingGeneration
        lock.unlock()

        buffer?.isBufferEnabled = enabled
        if enabled {
            buffer?.start()
        } else {
            buffer?.stop()
        }

        // Screen identity is control-plane state. Send this transition directly
        // instead of through the disabled buffer so CtrlProxy can discard an
        // identity that would otherwise outlive SDK tracking.
        if initialized && wasEnabled != enabled {
            SdkEventBroadcaster.shared.broadcastBatch(
                bundleId: bundleId,
                events: [SdkLifecycleEvent(
                    state: enabled ? "sdk_tracking_enabled" : "sdk_tracking_disabled",
                    bundleId: bundleId,
                    sessionId: currentSessionId,
                    sessionEpoch: currentSessionEpoch,
                    trackingGeneration: currentTrackingGeneration
                )]
            )
        }

        // Propagate to all subsystems (only if initialized). Skip subsystems
        // the host opted out of at init time so toggling setEnabled(true)
        // cannot start a watchdog or register URLProtocol that the host
        // explicitly disabled.
        guard initialized else { return }
        if config?.enableHangDetection ?? true {
            AutoMobileHangs.shared.setEnabled(enabled)
        }
        AutoMobileOsEvents.shared.setEnabled(enabled)
        AutoMobileNotificationObserver.shared.setEnabled(enabled)
        AutoMobileInteractionTracker.shared.setEnabled(enabled)
        if config?.enableNetworkCapture ?? true {
            AutoMobileNetwork.shared.setEnabled(enabled)
        }
        // Crashes: signal handlers can't be safely uninstalled; the exception handler
        // already checks AutoMobileSDK.shared.isEnabled before posting events.
    }

    private static func nextSessionEpoch() -> Int64 {
        let defaults = UserDefaults.standard
        let previousEpoch = Int64(defaults.integer(forKey: sessionEpochDefaultsKey))
        let currentMilliseconds = Int64(Date().timeIntervalSince1970 * 1000)
        let nextEpoch = previousEpoch == Int64.max ? currentMilliseconds : max(previousEpoch + 1, currentMilliseconds)
        defaults.set(nextEpoch, forKey: sessionEpochDefaultsKey)
        return nextEpoch
    }

    /// Whether the SDK has been initialized.
    public var isInitialized: Bool {
        lock.lock()
        defer { lock.unlock() }
        return _isInitialized
    }

    /// The current SDK configuration, or nil if not yet initialized.
    public var configuration: AutoMobileConfiguration? {
        lock.lock()
        defer { lock.unlock() }
        return _configuration
    }

    /// The app's bundle ID.
    public var bundleId: String? {
        lock.lock()
        defer { lock.unlock() }
        return _bundleId
    }

    /// The event buffer (for subsystems that need direct access).
    internal func getEventBuffer() -> SdkEventBuffer? {
        lock.lock()
        defer { lock.unlock() }
        return eventBuffer
    }

    // MARK: - Context

    /// The SDK context holding ambient state attached to events.
    internal var sdkContext: SdkContext? {
        lock.lock()
        defer { lock.unlock() }
        return _sdkContext
    }

    /// Set the current user ID for event attribution.
    public func setUserId(_ userId: String?) {
        sdkContext?.userId = userId
    }

    /// Set a custom tag on the SDK context.
    public func setTag(_ key: String, value: String) {
        sdkContext?.setTag(key, value: value)
    }

    /// Remove a custom tag from the SDK context.
    public func removeTag(_ key: String) {
        sdkContext?.removeTag(key)
    }

    /// The drop counter tracking events lost due to buffer overflow, disabled state, or flush errors.
    internal var dropCounter: (any DropCounting)? {
        lock.lock()
        defer { lock.unlock() }
        return _dropCounter
    }

    /// Returns a snapshot of drop counts by reason.
    public var dropReport: [DropReason: Int] {
        lock.lock()
        let counter = _dropCounter
        lock.unlock()
        return counter?.snapshot() ?? [:]
    }

    // MARK: - Testing Support

    /// Reset the SDK for testing. Not for production use.
    internal func reset() {
        shutdown()
    }
}
