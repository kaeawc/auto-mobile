#if canImport(UIKit) && !os(watchOS)
import Foundation
import UIKit

/// Polls the live UIView hierarchy on a timer, computes a structural hash,
/// and pushes changes to control-proxy via the SDK event buffer.
///
/// Follows the same singleton + initialize/reset pattern as `ViewBodyTracker`.
public final class ViewHierarchyTracker: @unchecked Sendable {
    public static let shared = ViewHierarchyTracker()

    private let lock = NSLock()
    private var buffer: SdkEventBuffer?
    private var pollTimer: (any TimerScheduling)?
    private var _latestHierarchy: SdkViewHierarchy?
    private var _latestHash: Int = 0
    private var applicationIsActive = false
    private var lifecycleObservers: [NSObjectProtocol] = []
    private let pollIntervalMs: Int = 1000
    #if DEBUG
    private var hierarchyServer: SdkHierarchyServer?
    #endif

    private init() {}

    // MARK: - Lifecycle

    func initialize(buffer: SdkEventBuffer, timerFactory: (() -> any TimerScheduling)? = nil) {
        lock.lock()
        self.buffer = buffer
        let timer = timerFactory?() ?? GCDTimer()
        self.pollTimer = timer
        lock.unlock()

        observeApplicationLifecycle()
        timer.schedule(intervalMs: pollIntervalMs) { [weak self] in
            self?.poll()
        }

        #if DEBUG
        let server = SdkHierarchyServer(tracker: self)
        lock.lock()
        self.hierarchyServer = server
        lock.unlock()
        server.start()
        #endif
    }

    func reset() {
        lock.lock()
        pollTimer?.cancel()
        pollTimer = nil
        buffer = nil
        _latestHierarchy = nil
        _latestHash = 0
        applicationIsActive = false
        let observers = lifecycleObservers
        lifecycleObservers = []
        #if DEBUG
        let server = hierarchyServer
        hierarchyServer = nil
        #endif
        lock.unlock()

        #if DEBUG
        server?.stop()
        #endif
        let center = NotificationCenter.default
        for observer in observers {
            center.removeObserver(observer)
        }
    }

    // MARK: - On-Demand Access

    /// Returns the most recently cached hierarchy snapshot (no main-thread work).
    public func getLatestHierarchy() -> SdkViewHierarchy? {
        lock.lock()
        defer { lock.unlock() }
        return _latestHierarchy
    }

    var bundleId: String? {
        AutoMobileSDK.shared.bundleId
    }

    var isApplicationActive: Bool {
        lock.lock()
        defer { lock.unlock() }
        return applicationIsActive
    }

    /// Performs a synchronous main-thread walk and returns the result.
    /// Must NOT be called from the main thread (will deadlock).
    public func walkNow() -> SdkViewHierarchy {
        var result: SdkViewHierarchy!
        if Thread.isMainThread {
            result = performWalk()
        } else {
            DispatchQueue.main.sync {
                result = self.performWalk()
            }
        }
        lock.lock()
        _latestHierarchy = result
        _latestHash = ViewHierarchyWalker.computeHash(result)
        lock.unlock()
        return result
    }

    // MARK: - Polling

    private func poll() {
        guard AutoMobileSDK.shared.isEnabled else { return }

        DispatchQueue.main.async { [weak self] in
            self?.refreshApplicationActiveState()
            self?.walkAndBroadcastIfChanged()
        }
    }

    private func observeApplicationLifecycle() {
        // `refreshApplicationActiveState` takes `lock`, so seed the state before
        // acquiring it (NSLock is not recursive).
        refreshApplicationActiveState()
        let center = NotificationCenter.default
        lock.lock()
        guard lifecycleObservers.isEmpty else {
            // Already observing: a second `initialize()` must not double-register,
            // and `reset()` must not be able to interleave with the publish below.
            lock.unlock()
            return
        }
        lifecycleObservers = [
            center.addObserver(
                forName: UIApplication.didBecomeActiveNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in self?.setApplicationActive(true) },
            center.addObserver(
                forName: UIApplication.willResignActiveNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in self?.setApplicationActive(false) },
            center.addObserver(
                forName: UIApplication.didEnterBackgroundNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in self?.setApplicationActive(false) },
        ]
        lock.unlock()
    }

    private func refreshApplicationActiveState() {
        setApplicationActive(UIApplication.shared.applicationState == .active)
    }

    private func setApplicationActive(_ isActive: Bool) {
        lock.lock()
        applicationIsActive = isActive
        lock.unlock()
    }

    private func walkAndBroadcastIfChanged() {
        let hierarchy = performWalk()
        let hash = ViewHierarchyWalker.computeHash(hierarchy)

        lock.lock()
        let previousHash = _latestHash
        _latestHierarchy = hierarchy
        _latestHash = hash
        let currentBuffer = buffer
        lock.unlock()

        guard hash != previousHash else { return }

        let event = SdkViewHierarchyEvent(hierarchy: hierarchy)
        currentBuffer?.add(event)
    }

    private func performWalk() -> SdkViewHierarchy {
        let bundleId = AutoMobileSDK.shared.bundleId
        return ViewHierarchyWalker.walk(bundleId: bundleId)
    }
}

#if DEBUG
extension ViewHierarchyTracker: SdkHierarchyServing {}
#endif
#endif
