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

/// Global signal handler that records crash events for signal-based faults.
/// This handles SIGABRT (fatalError, precondition), SIGSEGV, SIGBUS, etc.
private func signalHandler(signal sig: Int32) {
    let signalName: String
    switch sig {
    case SIGABRT: signalName = "SIGABRT"
    case SIGSEGV: signalName = "SIGSEGV"
    case SIGBUS: signalName = "SIGBUS"
    case SIGFPE: signalName = "SIGFPE"
    case SIGILL: signalName = "SIGILL"
    case SIGTRAP: signalName = "SIGTRAP"
    default: signalName = "SIGNAL(\(sig))"
    }

    let crashes = AutoMobileCrashes.shared
    let stackTrace = Thread.callStackSymbols.joined(separator: "\n")

    let event = SdkCrashEvent(
        errorDomain: signalName,
        errorMessage: "Process received \(signalName)",
        stackTrace: stackTrace,
        currentScreen: nil, // Cannot safely call provider in signal context
        bundleId: Bundle.main.bundleIdentifier ?? "",
        appVersion: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String,
        deviceInfo: AutoMobileFailures.currentDeviceInfo()
    )

    crashes.getEventBuffer()?.add(event)
    crashes.getEventBuffer()?.flush()

    // Re-raise the signal with default handler to allow normal crash behavior
    Darwin.signal(sig, SIG_DFL)
    Darwin.raise(sig)
}

// MARK: - Internal accessor for signal handler

extension AutoMobileCrashes {
    func getEventBuffer() -> SdkEventBuffer? {
        lock.lock()
        defer { lock.unlock() }
        // Access the buffer from the SDK since it's weak here
        return AutoMobileSDK.shared.getEventBuffer()
    }
}
