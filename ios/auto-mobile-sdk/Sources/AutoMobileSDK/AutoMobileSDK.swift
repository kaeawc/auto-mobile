import Foundation
#if canImport(UIKit)
import UIKit
#endif

/// Main entry point for the AutoMobile iOS SDK.
/// Provides navigation event tracking, log filtering, network monitoring,
/// crash detection, and more.
public final class AutoMobileSDK: @unchecked Sendable {
    public static let shared = AutoMobileSDK()

    private let lock = NSLock()
    private var listeners: [NavigationListener] = []
    private var _isEnabled = true
    private var _isInitialized = false
    private var _bundleId: String?
    private var _sdkContext: SdkContext?
    private var _configuration: AutoMobileConfiguration?
    private var eventBuffer: SdkEventBuffer?
    private var _dropCounter: DefaultDropCounter?
    private var eventPersistence: (any EventPersisting)?
    private var sessionTracker: SessionTracker?
    private var sessionObservers: [NSObjectProtocol] = []

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
        _configuration = configuration

        let counter = DefaultDropCounter()
        _dropCounter = counter

        // Set up disk-first event persistence
        let persistence: any EventPersisting
        if let cachesDir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first {
            let eventsDir = cachesDir.appendingPathComponent("automobile_events")
            persistence = FileEventPersistence(directory: eventsDir)
        } else {
            let tmpDir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("automobile_events")
            persistence = FileEventPersistence(directory: tmpDir)
        }
        self.eventPersistence = persistence
        SdkEventBroadcaster.shared.persistence = persistence

        let buffer = SdkEventBuffer(dropCounter: counter) { [weak self] events in
        let buffer = SdkEventBuffer(
            maxBufferSize: configuration.bufferSize,
            flushIntervalMs: configuration.flushIntervalMs
        ) { [weak self] events in
            let bundleId = self?.bundleId
            SdkEventBroadcaster.shared.broadcastBatch(bundleId: bundleId, events: events)
        }
        self.eventBuffer = buffer
        lock.unlock()

        buffer.start()

        // Replay any pending batches from previous sessions and clean up old ones
        persistence.cleanup(maxAgeDays: 7)
        SdkEventBroadcaster.shared.replayPending(bundleId: resolvedBundleId)

        // Initialize subsystems
        AutoMobileLog.shared.initialize(bundleId: resolvedBundleId, buffer: buffer)
        AutoMobileNetwork.shared.initialize(bundleId: resolvedBundleId, buffer: buffer)
        AutoMobileFailures.shared.initialize(bundleId: resolvedBundleId, buffer: buffer)
        AutoMobileCrashes.shared.initialize(bundleId: resolvedBundleId, buffer: buffer)
        AutoMobileHangs.shared.initialize(bundleId: resolvedBundleId, buffer: buffer)
        AutoMobileHangs.shared.startMonitoring()
        AutoMobileOsEvents.shared.initialize(bundleId: resolvedBundleId, buffer: buffer)
        AutoMobileNotificationObserver.shared.initialize(bundleId: resolvedBundleId, buffer: buffer)
        AutoMobileInteractionTracker.shared.initialize(bundleId: resolvedBundleId, buffer: buffer)
        ViewBodyTracker.shared.initialize(buffer: buffer)
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
        lock.unlock()

        for listener in currentListeners {
            listener.onNavigationEvent(event)
        }

        // Buffer as SDK event
        let sdkEvent = SdkNavigationEvent(
            timestamp: event.timestamp,
            destination: event.destination,
            source: NavigationSourceType(rawValue: event.source.rawValue) ?? .custom,
            arguments: event.arguments,
            metadata: event.metadata
        )
        eventBuffer?.add(sdkEvent)
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

    // MARK: - Custom Events

    /// Track a custom event with optional properties.
    public func trackEvent(name: String, properties: [String: String] = [:]) {
        guard isEnabled else {
            NSLog("[AutoMobileSDK] trackEvent(\(name)) skipped: SDK disabled")
            return
        }
        NSLog("[AutoMobileSDK] trackEvent(\(name)), buffer=\(eventBuffer != nil ? "exists" : "nil")")
        let event = SdkCustomEvent(name: name, properties: properties)
        eventBuffer?.add(event)
    }

    // MARK: - Enable/Disable

    /// Whether the SDK is enabled for tracking.
    public var isEnabled: Bool {
        lock.lock()
        defer { lock.unlock() }
        return _isEnabled
    }

    /// Enable or disable the SDK.
    /// When disabled, the event buffer stops accepting events and its flush timer is cancelled.
    public func setEnabled(_ enabled: Bool) {
        lock.lock()
        _isEnabled = enabled
        let buffer = eventBuffer
        lock.unlock()

        buffer?.isBufferEnabled = enabled
        if enabled {
            buffer?.start()
        } else {
            buffer?.stop()
        }
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
    public func getEventBuffer() -> SdkEventBuffer? {
        lock.lock()
        defer { lock.unlock() }
        return eventBuffer
    }

    // MARK: - Context

    /// The SDK context holding ambient state attached to events.
    public var sdkContext: SdkContext? {
        lock.lock()
        defer { lock.unlock() }
        return _sdkContext
    }

    public func setUserId(_ userId: String?) {
        sdkContext?.userId = userId
    }

    public func setTag(_ key: String, value: String) {
        sdkContext?.setTag(key, value: value)
    }

    public func removeTag(_ key: String) {
        sdkContext?.removeTag(key)
    }

    /// The drop counter tracking events lost due to buffer overflow, disabled state, or flush errors.
    public var dropCounter: (any DropCounting)? {
        lock.lock()
        defer { lock.unlock() }
        return _dropCounter
    }

    // MARK: - Testing Support

    /// Reset the SDK for testing. Not for production use.
    internal func reset() {
        // Reset all subsystems in reverse initialization order
        SwiftUINavigationAdapter.shared.stop()
        AutoMobileCrashes.shared.reset()
        AutoMobileHangs.shared.reset()
        AutoMobileOsEvents.shared.reset()
        AutoMobileNotificationObserver.shared.reset()
        AutoMobileInteractionTracker.shared.reset()
        ViewBodyTracker.shared.reset()
        UserDefaultsInspector.shared.reset()
        DatabaseInspector.shared.reset()
        AutoMobileNetwork.shared.reset()
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
        eventPersistence = nil
        SdkEventBroadcaster.shared.persistence = nil
        listeners.removeAll()
        _isEnabled = true
        _isInitialized = false
        _bundleId = nil
        _configuration = nil
        lock.unlock()

        bufferToShutdown?.shutdown()
    }
}
