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

        setupSignalCrashFile()
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
            let prev = signal(sig, signalHandler)
            let idx = Int(sig)
            if idx >= 0, idx < previousSignalHandlers.count,
               prev != SIG_DFL, prev != SIG_ERR, prev != SIG_IGN {
                previousSignalHandlers[idx] = prev
            }
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

/// File path for persisting signal number across crashes.
/// Computed once during initialization and stored as a C string for signal safety.
private var signalCrashFilePath: UnsafeMutablePointer<CChar>?

/// Previous signal handlers saved before installing ours, for chaining.
/// Array indexed by signal number for O(1) lookup in the signal handler.
private var previousSignalHandlers: [(@convention(c) (Int32) -> Void)?] = Array(repeating: nil, count: 64)

/// Global signal handler for signal-based faults (SIGABRT, SIGSEGV, etc.).
/// Only performs async-signal-safe operations: writes signal number to a file
/// using POSIX write(), then chains to the previous handler or re-raises.
private func signalHandler(sig: Int32) {
    // Write signal number to file using only async-signal-safe functions
    if let path = signalCrashFilePath {
        let fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0o644)
        if fd >= 0 {
            var sigValue = sig
            _ = Darwin.write(fd, &sigValue, MemoryLayout<Int32>.size)
            close(fd)
        }
    }

    // Chain to previous handler if one was installed
    let idx = Int(sig)
    if idx >= 0, idx < previousSignalHandlers.count, let prev = previousSignalHandlers[idx] {
        prev(sig)
    } else {
        // No previous handler — re-raise with default
        signal(sig, SIG_DFL)
        raise(sig)
    }
}

// MARK: - Previous Signal Crash Detection

extension AutoMobileCrashes {
    /// Set up the file path for signal crash persistence.
    func setupSignalCrashFile() {
        let cacheDir = NSSearchPathForDirectoriesInDomains(.cachesDirectory, .userDomainMask, true).first ?? NSTemporaryDirectory()
        let filePath = (cacheDir as NSString).appendingPathComponent("automobile_last_signal_crash")
        signalCrashFilePath = strdup(filePath)
    }

    /// Check if the previous session ended with a signal crash.
    func checkPreviousSignalCrash() {
        guard let path = signalCrashFilePath else { return }
        let filePath = String(cString: path)

        let fd = open(path, O_RDONLY)
        guard fd >= 0 else { return }

        var sigValue: Int32 = 0
        let bytesRead = Darwin.read(fd, &sigValue, MemoryLayout<Int32>.size)
        close(fd)
        unlink(path) // Remove the file after reading

        guard bytesRead == MemoryLayout<Int32>.size, sigValue != 0 else { return }

        let signalName: String
        switch sigValue {
        case SIGABRT: signalName = "SIGABRT"
        case SIGSEGV: signalName = "SIGSEGV"
        case SIGBUS: signalName = "SIGBUS"
        case SIGFPE: signalName = "SIGFPE"
        case SIGILL: signalName = "SIGILL"
        case SIGTRAP: signalName = "SIGTRAP"
        default: signalName = "SIGNAL(\(sigValue))"
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

        // Log for debugging
        NSLog("[AutoMobile] Previous session crashed with %@", filePath)
    }
}
