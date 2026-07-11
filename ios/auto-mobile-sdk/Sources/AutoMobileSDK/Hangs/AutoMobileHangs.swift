import Foundation

/// Main thread hang detection.
/// iOS equivalent of Android's ANR detection.
/// Monitors the main thread and reports when it's blocked for too long.
public final class AutoMobileHangs: @unchecked Sendable {
    public static let shared = AutoMobileHangs()

    private let lock = NSLock()
    private var bundleId: String?
    private var buffer: SdkEventBuffer?
    private var watchdogThread: Thread?
    private var _isMonitoring = false
    private var monitorGeneration: UInt64 = 0

    private var _hangThresholdMs: Double = 2000
    private var _pollIntervalMs: Double = 500

    /// Threshold in milliseconds before a hang is reported. Default: 2000ms.
    public var hangThresholdMs: Double {
        get { lock.lock(); defer { lock.unlock() }; return _hangThresholdMs }
        set { lock.lock(); defer { lock.unlock() }; _hangThresholdMs = newValue }
    }

    /// Polling interval in milliseconds. Default: 500ms.
    public var pollIntervalMs: Double {
        get { lock.lock(); defer { lock.unlock() }; return _pollIntervalMs }
        set { lock.lock(); defer { lock.unlock() }; _pollIntervalMs = newValue }
    }

    // MARK: - Injectable seams (deterministic testing, #3622)

    /// Monotonic clock in milliseconds. Overridden in tests.
    var monotonicNowMs: () -> Double = { CFAbsoluteTimeGetCurrent() * 1000 }

    /// Probe the monitored thread: dispatch to it and return `true` if it services
    /// the probe within `timeoutMs`, `false` if it is blocked. Overridden in tests.
    var probeMainThread: (_ timeoutMs: Double) -> Bool = { timeoutMs in
        let semaphore = DispatchSemaphore(value: 0)
        DispatchQueue.main.async { semaphore.signal() }
        return semaphore.wait(timeout: .now() + .milliseconds(Int(timeoutMs))) == .success
    }

    /// Sleep for the given milliseconds. Overridden in tests.
    var sleepMs: (Double) -> Void = { Thread.sleep(forTimeInterval: $0 / 1000.0) }

    private init() {}

    /// Test-only instance so the watchdog logic can be exercised in isolation
    /// without touching the shared singleton.
    static func makeTestInstance() -> AutoMobileHangs { AutoMobileHangs() }

    func initialize(bundleId: String?, buffer: SdkEventBuffer) {
        lock.lock()
        self.bundleId = bundleId
        self.buffer = buffer
        lock.unlock()
    }

    /// Start monitoring the main thread for hangs.
    public func startMonitoring() {
        lock.lock()
        guard !_isMonitoring else {
            lock.unlock()
            return
        }
        _isMonitoring = true
        monitorGeneration &+= 1
        let generation = monitorGeneration
        lock.unlock()

        let thread = Thread { [weak self] in
            self?.watchdogLoop(generation: generation)
        }
        thread.name = "dev.jasonpearson.automobile.sdk.hang-detector"
        thread.qualityOfService = .userInitiated

        lock.lock()
        watchdogThread = thread
        lock.unlock()

        thread.start()
    }

    /// Stop monitoring.
    public func stopMonitoring() {
        lock.lock()
        _isMonitoring = false
        watchdogThread?.cancel()
        watchdogThread = nil
        lock.unlock()
    }

    public var isMonitoring: Bool {
        lock.lock()
        defer { lock.unlock() }
        return _isMonitoring
    }

    private func isMonitoring(generation: UInt64) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return _isMonitoring && monitorGeneration == generation
    }

    /// Enable or disable hang detection.
    /// When disabled, the watchdog thread is stopped. When re-enabled, it restarts.
    public func setEnabled(_ enabled: Bool) {
        if enabled {
            startMonitoring()
        } else {
            stopMonitoring()
        }
    }

    private func watchdogLoop(generation: UInt64) {
        while isMonitoring(generation: generation) {
            if let durationMs = runWatchdogCycle(shouldContinue: { [weak self] in
                self?.isMonitoring(generation: generation) ?? false
            }) {
                reportHang(durationMs: durationMs, stackTrace: captureMainThreadStack())
            }
            sleepMs(pollIntervalMs)
        }
    }

    /// Run a single watchdog cycle: probe the monitored thread once, and if it is
    /// hung, wait for it to recover and return the duration of the **whole** hang.
    ///
    /// This is the latch that fixes #3622: a single cycle consumes an entire hang
    /// episode (probe → wait-for-recovery → one report), so a sustained hang yields
    /// exactly one event whose duration spans first detection to recovery — instead
    /// of one event per poll interval, each mis-reporting only ~`hangThresholdMs`.
    /// Returns `nil` when the thread is responsive, or when `shouldContinue` goes
    /// false before recovery (e.g. monitoring stopped / permanent hang until crash).
    func runWatchdogCycle(shouldContinue: () -> Bool) -> Double? {
        let threshold = hangThresholdMs
        let probeStart = monotonicNowMs()
        guard !probeMainThread(threshold) else {
            return nil // responsive within threshold — no hang
        }
        // Hang in progress. Keep probing until the thread recovers, then report once.
        while shouldContinue() {
            if probeMainThread(threshold) {
                return monotonicNowMs() - probeStart
            }
        }
        return nil
    }

    /// Capture stack trace context during a hang.
    /// Note: iOS does not provide a public API to capture another thread's stack.
    /// This captures the watchdog thread's stack as a diagnostic marker that a hang
    /// was detected, not the actual blocking call stack on the main thread.
    /// For production hang diagnostics, use MetricKit's MXHangDiagnostic (iOS 16+).
    private func captureMainThreadStack() -> String? {
        let symbols = Thread.callStackSymbols
        if symbols.isEmpty { return nil }
        return "Hang detected (watchdog thread stack — use MetricKit for main thread stack):\n" + symbols.joined(separator: "\n")
    }

    private func reportHang(durationMs: Double, stackTrace: String?) {
        guard AutoMobileSDK.shared.isEnabled else { return }

        lock.lock()
        let currentBundleId = bundleId ?? Bundle.main.bundleIdentifier ?? ""
        let currentBuffer = buffer
        lock.unlock()

        let event = SdkHangEvent(
            durationMs: durationMs,
            stackTrace: stackTrace,
            bundleId: currentBundleId
        )
        currentBuffer?.add(event)
    }

    // MARK: - Testing Support

    internal func reset() {
        stopMonitoring()
        lock.lock()
        bundleId = nil
        buffer = nil
        lock.unlock()
    }
}
