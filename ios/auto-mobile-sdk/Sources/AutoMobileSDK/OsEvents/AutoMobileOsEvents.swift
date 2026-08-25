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
    /// Monotonic initialization generation, bumped on every `initialize()`/`shutdown()`.
    /// The setup code captures it and only publishes its observers / path-monitor if it
    /// still matches — so a shutdown+reinitialize (ABA) during setup can't let a stale
    /// init's resources land in a newer init's session.
    private var _initGeneration = 0

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

        #if canImport(UIKit) && !os(watchOS)
        setupLifecycleTracking(generation: generation)
        setupBatteryTracking(generation: generation)
        setupScreenTracking(generation: generation)
        #endif

        #if canImport(Network)
        setupConnectivityTracking(generation: generation)
        #endif
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
        observers.append(contentsOf: newObservers)
        lock.unlock()
    }

    // MARK: - Lifecycle Tracking

    #if canImport(UIKit) && !os(watchOS)
    private func setupLifecycleTracking(generation: Int) {
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

        storeObservers([fgObserver, bgObserver, willResignObserver, willTerminateObserver], generation: generation)
    }

    // MARK: - Battery Tracking

    private func setupBatteryTracking(generation: Int) {
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

        storeObservers([levelObserver, stateObserver], generation: generation)
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

    private func setupScreenTracking(generation: Int) {
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

        storeObservers([brightnessObserver], generation: generation)
    }
    #endif

    // MARK: - Connectivity Tracking

    #if canImport(Network)
    private func setupConnectivityTracking(generation: Int) {
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

        lock.lock()
        // If a shutdown() (or shutdown+reinitialize ABA) interleaved since initialize()
        // released the lock, this generation no longer matches — don't store or start the
        // monitor, it would run after teardown / in a newer init's session. Cancel it.
        guard generation == _initGeneration else {
            lock.unlock()
            monitor.cancel()
            return
        }
        pathMonitor = monitor
        monitorQueue = queue
        lock.unlock()

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
