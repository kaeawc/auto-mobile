import Foundation
#if canImport(UIKit)
import UIKit
#endif

/// Tracks system notification broadcasts (locale, timezone, memory warnings).
/// iOS equivalent of Android's AutoMobileBroadcastInterceptor.
/// Monitors a curated set of system notifications and records them as events.
public final class AutoMobileNotificationObserver: @unchecked Sendable {
    public static let shared = AutoMobileNotificationObserver()

    private let lock = NSLock()
    private var buffer: SdkEventBuffer?
    private var bundleId: String?
    private var _isInitialized = false
    private var _isEnabled = true
    private var observers: [NSObjectProtocol] = []
    /// Monotonic initialization generation, bumped on every `initialize()`/`shutdown()`.
    /// The registering code captures it and only publishes its observers if it still
    /// matches — so a shutdown+reinitialize (ABA) that happens while registration is in
    /// flight can't let a stale init's observers land in a newer init's session.
    private var _initGeneration = 0

    private init() {}

    // MARK: - Enable/Disable

    /// Whether notification observation is enabled.
    public var isEnabled: Bool {
        lock.lock()
        defer { lock.unlock() }
        return _isEnabled
    }

    /// Enable or disable notification observation.
    /// When disabled, notification callbacks short-circuit and no events are recorded.
    public func setEnabled(_ enabled: Bool) {
        lock.lock()
        _isEnabled = enabled
        lock.unlock()
    }

    // MARK: - Initialization

    func initialize(bundleId: String?, buffer: SdkEventBuffer) {
        lock.lock()
        guard !_isInitialized else {
            lock.unlock()
            return
        }
        _isInitialized = true
        _initGeneration += 1
        let generation = _initGeneration
        self.bundleId = bundleId
        self.buffer = buffer
        lock.unlock()

        registerObservers(generation: generation)
    }

    func shutdown() {
        lock.lock()
        _isInitialized = false
        _initGeneration += 1
        _isEnabled = true
        for observer in observers {
            NotificationCenter.default.removeObserver(observer)
        }
        observers.removeAll()
        buffer = nil
        bundleId = nil
        lock.unlock()
    }

    // MARK: - Observer Registration

    private func registerObservers(generation: Int) {
        let notificationsToMonitor: [(Notification.Name, String)] = [
            (NSLocale.currentLocaleDidChangeNotification, "locale_changed"),
            (.NSSystemTimeZoneDidChange, "timezone_changed"),
            (.NSProcessInfoPowerStateDidChange, "power_state_changed"),
        ]

        #if canImport(UIKit) && !os(watchOS)
        let uiKitNotifications: [(Notification.Name, String)] = [
            (UIApplication.didReceiveMemoryWarningNotification, "memory_warning"),
            (UIApplication.significantTimeChangeNotification, "significant_time_change"),
            (UIApplication.userDidTakeScreenshotNotification, "screenshot_taken"),
        ]
        let allNotifications = notificationsToMonitor + uiKitNotifications
        #else
        let allNotifications = notificationsToMonitor
        #endif

        var newObservers: [NSObjectProtocol] = []
        for (name, action) in allNotifications {
            let observer = NotificationCenter.default.addObserver(
                forName: name,
                object: nil,
                queue: nil
            ) { [weak self] notification in
                self?.handleNotification(action: action, notification: notification)
            }
            newObservers.append(observer)
        }

        storeObservers(newObservers, generation: generation)
    }

    /// Number of currently-stored observers. Internal so tests can assert the
    /// register-vs-shutdown guard without reaching into `NotificationCenter`.
    var observerCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return observers.count
    }

    /// Current initialization generation — internal so tests can capture it and drive an
    /// A→shutdown→B→A publication race deterministically.
    var initGeneration: Int {
        lock.lock()
        defer { lock.unlock() }
        return _initGeneration
    }

    /// Publishes the just-registered observers only if `generation` is still the current
    /// initialization generation — i.e. no `shutdown()` (nor a shutdown+reinitialize ABA)
    /// interleaved since these observers were built. Otherwise removes them so they can't
    /// fire after teardown or leak into a newer init's session. Internal so tests can
    /// drive the drop path deterministically.
    func storeObservers(_ newObservers: [NSObjectProtocol], generation: Int) {
        lock.lock()
        guard generation == _initGeneration else {
            lock.unlock()
            for observer in newObservers {
                NotificationCenter.default.removeObserver(observer)
            }
            return
        }
        observers = newObservers
        lock.unlock()
    }

    private func handleNotification(action: String, notification: Notification) {
        guard AutoMobileSDK.shared.isEnabled else { return }

        lock.lock()
        guard _isEnabled else {
            lock.unlock()
            return
        }
        let currentBuffer = buffer
        lock.unlock()

        // Capture user info key names and value types (not values) to avoid leaking sensitive data
        var infoKeyTypes: [String: String] = [:]
        if let userInfo = notification.userInfo {
            for (key, value) in userInfo {
                infoKeyTypes["\(key)"] = String(describing: type(of: value))
            }
        }

        let event = SdkBroadcastEvent(
            action: action,
            categories: nil,
            infoKeyTypes: infoKeyTypes.isEmpty ? nil : infoKeyTypes
        )
        currentBuffer?.add(event)
    }

    // MARK: - Testing Support

    internal func reset() {
        shutdown()
    }
}
