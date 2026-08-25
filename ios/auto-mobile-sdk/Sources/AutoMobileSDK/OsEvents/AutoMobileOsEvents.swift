import Foundation
#if canImport(UIKit)
import UIKit
#endif
#if canImport(Network)
import Network
#endif

/// Tracks OS-level lifecycle events: foreground/background, connectivity, battery, and screen state.
/// iOS equivalent of Android's AutoMobileOsEvents.
public final class AutoMobileOsEvents: @unchecked Sendable {
    public static let shared = AutoMobileOsEvents()

    private let lock = NSLock()
    private var buffer: SdkEventBuffer?
    private var bundleId: String?
    private var _isInitialized = false

    #if canImport(Network)
    private var pathMonitor: NWPathMonitor?
    private var monitorQueue: DispatchQueue?
    #endif

    private var lastBatteryLevel: Int?
    private var lastBatteryCharging: Bool?
    private var observers: [NSObjectProtocol] = []
    private var _isEnabled = true

    private init() {}

    // MARK: - Enable/Disable

    /// Whether OS event tracking is enabled.
    public var isEnabled: Bool {
        lock.lock()
        defer { lock.unlock() }
        return _isEnabled
    }

    /// Enable or disable OS event tracking.
    /// When disabled, observer callbacks short-circuit and no events are recorded.
    public func setEnabled(_ enabled: Bool) {
        lock.lock()
        _isEnabled = enabled
        lock.unlock()
    }

    // MARK: - Initialization

    func initialize(bundleId: String?, buffer: SdkEventBuffer) {
        lock.lock()
        defer { lock.unlock() }
        guard !_isInitialized else { return }
        _isInitialized = true
        self.bundleId = bundleId
        self.buffer = buffer

        // Register all observers and the path monitor WHILE holding the lock, so setup is
        // one critical section with respect to shutdown(): a shutdown() cannot interleave
        // between building a resource and storing it, so no observer, path monitor, or the
        // `isBatteryMonitoringEnabled` side-effect can outlive a teardown that races setup.
        // addObserver / NWPathMonitor.start deliver only asynchronously, so holding the
        // lock across them cannot re-enter it.
        #if canImport(UIKit) && !os(watchOS)
        setupLifecycleTrackingLocked()
        setupBatteryTrackingLocked()
        setupScreenTrackingLocked()
        #endif

        #if canImport(Network)
        setupConnectivityTrackingLocked()
        #endif
    }

    func shutdown() {
        lock.lock()
        _isInitialized = false
        _isEnabled = true

        for observer in observers {
            NotificationCenter.default.removeObserver(observer)
        }
        observers.removeAll()

        #if canImport(Network)
        pathMonitor?.cancel()
        pathMonitor = nil
        monitorQueue = nil
        #endif

        #if canImport(UIKit) && !os(watchOS)
        UIDevice.current.isBatteryMonitoringEnabled = false
        #endif

        buffer = nil
        bundleId = nil
        lastBatteryLevel = nil
        lastBatteryCharging = nil
        lock.unlock()
    }

    /// Number of currently-stored observers. Internal so tests can assert the
    /// register-vs-shutdown guard without reaching into `NotificationCenter`.
    var observerCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return observers.count
    }

    // MARK: - Lifecycle Tracking

    #if canImport(UIKit) && !os(watchOS)
    private func setupLifecycleTrackingLocked() {
        let fgObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.postEvent(state: "foreground")
        }

        let bgObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.postEvent(state: "background")
        }

        let willResignObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.willResignActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.postEvent(state: "inactive")
        }

        let willTerminateObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.willTerminateNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.postEvent(state: "terminated")
        }

        observers.append(contentsOf: [fgObserver, bgObserver, willResignObserver, willTerminateObserver])
    }

    // MARK: - Battery Tracking

    private func setupBatteryTrackingLocked() {
        UIDevice.current.isBatteryMonitoringEnabled = true

        let levelObserver = NotificationCenter.default.addObserver(
            forName: UIDevice.batteryLevelDidChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.reportBatteryChange()
        }

        let stateObserver = NotificationCenter.default.addObserver(
            forName: UIDevice.batteryStateDidChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.reportBatteryChange()
        }

        observers.append(contentsOf: [levelObserver, stateObserver])
    }

    private func reportBatteryChange() {
        let rawLevel = UIDevice.current.batteryLevel
        // iOS returns -1.0 when battery level is unavailable (simulator, unsupported)
        guard rawLevel >= 0 else { return }

        let level = Int(rawLevel * 100)
        let state = UIDevice.current.batteryState
        let charging = state == .charging || state == .full

        lock.lock()
        let changed = level != lastBatteryLevel || charging != lastBatteryCharging
        if changed {
            lastBatteryLevel = level
            lastBatteryCharging = charging
        }
        lock.unlock()

        guard changed else { return }

        postEvent(state: "battery_change", details: [
            "level": "\(level)",
            "charging": "\(charging)",
        ])
    }

    // MARK: - Screen Tracking

    private func setupScreenTrackingLocked() {
        let brightnessObserver = NotificationCenter.default.addObserver(
            forName: UIScreen.brightnessDidChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            let brightness = Int(UIScreen.main.brightness * 100)
            self?.postEvent(state: "screen_brightness_change", details: [
                "brightness": "\(brightness)",
            ])
        }

        observers.append(brightnessObserver)
    }
    #endif

    // MARK: - Connectivity Tracking

    #if canImport(Network)
    private func setupConnectivityTrackingLocked() {
        let monitor = NWPathMonitor()
        let queue = DispatchQueue(label: "dev.jasonpearson.automobile.sdk.network-monitor")

        monitor.pathUpdateHandler = { [weak self] path in
            let connected = path.status == .satisfied
            let transport: String
            if path.usesInterfaceType(.wifi) {
                transport = "wifi"
            } else if path.usesInterfaceType(.cellular) {
                transport = "cellular"
            } else if path.usesInterfaceType(.wiredEthernet) {
                transport = "ethernet"
            } else {
                transport = "other"
            }

            self?.postEvent(state: "connectivity_change", details: [
                "connected": "\(connected)",
                "transport": transport,
            ])
        }

        // Caller holds `lock`, so storing and starting the monitor is atomic with
        // shutdown() (which cancels it under the same lock).
        pathMonitor = monitor
        monitorQueue = queue
        monitor.start(queue: queue)
    }
    #endif

    // MARK: - Event Posting

    private func postEvent(state: String, details: [String: String] = [:]) {
        guard AutoMobileSDK.shared.isEnabled else { return }

        lock.lock()
        guard _isEnabled else {
            lock.unlock()
            return
        }
        let currentBuffer = buffer
        let currentBundleId = bundleId
        lock.unlock()

        let event = SdkLifecycleEvent(
            state: state,
            bundleId: currentBundleId,
            details: details
        )
        currentBuffer?.add(event)
    }

    // MARK: - Testing Support

    internal func reset() {
        shutdown()
    }
}
