import Foundation
#if canImport(UIKit)
import UIKit
#endif

/// Unhandled crash detection.
/// Installs an NSSetUncaughtExceptionHandler and signal handlers to detect crashes.
public final class AutoMobileCrashes: @unchecked Sendable {
    public static let shared = AutoMobileCrashes()

    private let lock = NSLock()
    private var bundleId: String?
    private weak var buffer: SdkEventBuffer?
    private var _isInitialized = false
    private var previousExceptionHandler: (@convention(c) (NSException) -> Void)?
    private var installedSignalHandlers = false

    /// Signals to intercept for crash reporting.
    private static let monitoredSignals: [Int32] = [SIGABRT, SIGSEGV, SIGBUS, SIGFPE, SIGILL, SIGTRAP]

    /// Provide a closure that returns the current screen name for crash context.
    public var currentScreenProvider: (@Sendable () -> String?)?

    private init() {}

    func initialize(bundleId: String?, buffer: SdkEventBuffer) {
        lock.lock()
        guard !_isInitialized else {
            lock.unlock()
            return
        }
        _isInitialized = true
        self.bundleId = bundleId
        self.buffer = buffer
        lock.unlock()

        // Save the previous handler so we can chain to it
        previousExceptionHandler = NSGetUncaughtExceptionHandler()

        NSSetUncaughtExceptionHandler { exception in
            AutoMobileCrashes.shared.handleException(exception)
        }

        installSignalHandlers()
        checkPreviousSignalCrash()
    }

    public var isInitialized: Bool {
        lock.lock()
        defer { lock.unlock() }
        return _isInitialized
    }

    // MARK: - Signal Handlers

    private func installSignalHandlers() {
        lock.lock()
        guard !installedSignalHandlers else {
            lock.unlock()
            return
        }
        installedSignalHandlers = true
        lock.unlock()

        for sig in Self.monitoredSignals {
            signal(sig, signalHandler)
        }
    }

    // MARK: - Exception Handler

    private func handleException(_ exception: NSException) {
        lock.lock()
        let currentBundleId = bundleId ?? Bundle.main.bundleIdentifier ?? ""
        let currentBuffer = buffer
        let previousHandler = previousExceptionHandler
        lock.unlock()

        let currentScreen = currentScreenProvider?()
        let stackTrace = exception.callStackSymbols.joined(separator: "\n")

        let event = SdkCrashEvent(
            errorDomain: exception.name.rawValue,
            errorMessage: exception.reason,
            stackTrace: stackTrace,
            currentScreen: currentScreen,
            bundleId: currentBundleId,
            appVersion: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String,
            deviceInfo: AutoMobileFailures.currentDeviceInfo()
        )

        currentBuffer?.add(event)
        currentBuffer?.flush()

        // Chain to previous handler
        previousHandler?(exception)
    }

    // MARK: - Testing Support

    internal func reset() {
        lock.lock()
        _isInitialized = false
        bundleId = nil
        buffer = nil
        previousExceptionHandler = nil
        currentScreenProvider = nil
        // Note: signal handlers cannot be safely uninstalled, leave installedSignalHandlers as-is
        lock.unlock()
    }
}

// MARK: - Signal Handler (must be a C function)

/// Shared mutable state written before crash, read in signal handler.
/// Uses only async-signal-safe types (raw pointers and Int32).
private var capturedSignal: Int32 = 0

/// Global signal handler for signal-based faults (SIGABRT, SIGSEGV, etc.).
/// Only performs async-signal-safe operations: records the signal number and
/// re-raises with the default handler. The crash event is recorded on next
/// app launch via `AutoMobileCrashes.checkPreviousSignalCrash()`.
private func signalHandler(sig: Int32) {
    // Store signal number for next-launch reporting
    capturedSignal = sig

    // Re-raise with default handler to produce the normal crash behavior
    signal(sig, SIG_DFL)
    raise(sig)
}

// MARK: - Previous Signal Crash Detection

extension AutoMobileCrashes {
    private static let signalCrashKey = "dev.jasonpearson.automobile.sdk.lastSignalCrash"

    /// Call during initialization to check if the previous session ended with a signal crash.
    func checkPreviousSignalCrash() {
        let lastSignal = UserDefaults.standard.integer(forKey: Self.signalCrashKey)
        UserDefaults.standard.removeObject(forKey: Self.signalCrashKey)

        guard lastSignal != 0 else { return }

        let signalName: String
        switch lastSignal {
        case Int(SIGABRT): signalName = "SIGABRT"
        case Int(SIGSEGV): signalName = "SIGSEGV"
        case Int(SIGBUS): signalName = "SIGBUS"
        case Int(SIGFPE): signalName = "SIGFPE"
        case Int(SIGILL): signalName = "SIGILL"
        case Int(SIGTRAP): signalName = "SIGTRAP"
        default: signalName = "SIGNAL(\(lastSignal))"
        }

        lock.lock()
        let currentBundleId = bundleId ?? Bundle.main.bundleIdentifier ?? ""
        let currentBuffer = buffer
        lock.unlock()

        let event = SdkCrashEvent(
            errorDomain: signalName,
            errorMessage: "Previous session crashed with \(signalName)",
            stackTrace: "",
            currentScreen: nil,
            bundleId: currentBundleId,
            appVersion: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String,
            deviceInfo: AutoMobileFailures.currentDeviceInfo()
        )

        currentBuffer?.add(event)
    }

    /// Called by the signal handler to persist the signal number via UserDefaults.
    /// Note: UserDefaults.set is not async-signal-safe, but this is called from
    /// the atexit handler registered separately, not from the signal handler itself.
    static func persistSignalIfNeeded() {
        let sig = capturedSignal
        if sig != 0 {
            UserDefaults.standard.set(Int(sig), forKey: signalCrashKey)
        }
    }
}
