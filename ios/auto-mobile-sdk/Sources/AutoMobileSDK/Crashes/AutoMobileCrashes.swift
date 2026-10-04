import Foundation
#if canImport(UIKit)
    import UIKit
#endif

/// Unhandled crash detection.
/// Installs an NSSetUncaughtExceptionHandler and signal handlers to detect crashes.
public final class AutoMobileCrashes: @unchecked Sendable {
    public static let shared = AutoMobileCrashes()

    private let lock = NSLock()
    // Only initialize/reset acquire this lock. Serialize the process-handler
    // transaction without holding the state lock across injectable accessors;
    // handleException never acquires it, even when called from an accessor.
    private let lifecycleLock: any NSLocking
    private var bundleId: String?
    private var buffer: SdkEventBuffer?
    private var _isInitialized = false
    private var previousExceptionHandler: (@convention(c) (NSException) -> Void)?
    // A later reporter may still chain into our handler after reset(). Keep the
    // original predecessor and reactivate in place rather than capturing that
    // reporter on re-initialize (which would create a handler cycle).
    private var exceptionHandlerRetainedInChain = false
    private var installedSignalHandlers = false

    /// Signals to intercept for crash reporting.
    /// SIGTRAP is excluded — it's used by the debugger and Swift runtime for
    /// breakpoints and assertions; intercepting it breaks debugging and tests.
    private static let monitoredSignals: [Int32] = [SIGABRT, SIGSEGV, SIGBUS, SIGFPE, SIGILL]

    /// Provide a closure that returns the current screen name for crash context.
    /// Read in the exception handler and written from arbitrary threads (host app,
    /// `reset()`), so it is serialized by `lock` — reference/Optional assignment is
    /// not atomic in Swift's memory model (issue #3632), and every other field in
    /// this class is already lock-guarded.
    private var _currentScreenProvider: (@Sendable () -> String?)?
    public var currentScreenProvider: (@Sendable () -> String?)? {
        get {
            lock.lock()
            defer { lock.unlock() }
            return _currentScreenProvider
        }
        set {
            lock.lock()
            let old = _currentScreenProvider
            _currentScreenProvider = newValue
            lock.unlock()
            // Release the replaced closure AFTER unlocking: if it owned the last
            // reference to an object whose deinit re-enters this lock, releasing it
            // under the lock would deadlock (the non-recursive lock is not re-entrant).
            withExtendedLifetime(old) {}
        }
    }

    /// The process-global uncaught-exception handler that routes to this class.
    private static let uncaughtExceptionHandler: @convention(c) (NSException) -> Void = { exception in
        AutoMobileCrashes.shared.handleException(exception)
    }

    /// Injectable accessors for the process-global uncaught-exception handler
    /// (testing seam, #3633). Default to the real Foundation APIs; tests override
    /// them so they don't clobber the test runner's own handler.
    var captureUncaughtHandler: () -> (@convention(c) (NSException) -> Void)? = {
        NSGetUncaughtExceptionHandler()
    }

    var installUncaughtHandler: ((@convention(c) (NSException) -> Void)?) -> Void = {
        NSSetUncaughtExceptionHandler($0)
    }

    private init(lifecycleLock: any NSLocking = NSLock()) {
        self.lifecycleLock = lifecycleLock
    }

    /// Test-only instance to exercise initialize/reset in isolation.
    static func makeTestInstance(lifecycleLock: any NSLocking = NSLock()) -> AutoMobileCrashes {
        AutoMobileCrashes(lifecycleLock: lifecycleLock)
    }

    private static func isOwnHandler(_ handler: (@convention(c) (NSException) -> Void)?) -> Bool {
        handler.map {
            unsafeBitCast($0, to: UnsafeRawPointer.self)
                == unsafeBitCast(uncaughtExceptionHandler, to: UnsafeRawPointer.self)
        } ?? false
    }

    func initialize(bundleId: String?, buffer: SdkEventBuffer) {
        lifecycleLock.lock()
        defer { lifecycleLock.unlock() }

        lock.lock()
        guard !_isInitialized else {
            lock.unlock()
            return
        }
        let retainedInChain = exceptionHandlerRetainedInChain
        lock.unlock()

        // Call the process accessor outside the state lock; the injected
        // accessor may itself enter the exception handler. Lifecycle operations
        // must not synchronously re-enter initialize/reset from these accessors.
        let currentHandler = captureUncaughtHandler()
        let ownsCurrentHandler = Self.isOwnHandler(currentHandler)
        // A nil handler cannot chain to us. If our handler is current, reinstall
        // it while preserving its saved predecessor rather than capturing itself.
        let reactivateInPlace = retainedInChain && currentHandler != nil && !ownsCurrentHandler
        lock.lock()
        _isInitialized = true
        self.bundleId = bundleId
        self.buffer = buffer
        exceptionHandlerRetainedInChain = reactivateInPlace
        if !reactivateInPlace, !ownsCurrentHandler {
            previousExceptionHandler = currentHandler
        }
        lock.unlock()

        if !reactivateInPlace {
            installUncaughtHandler(Self.uncaughtExceptionHandler)
        }

        // Signal handlers are opt-in via enableSignalHandlers() because they
        // interfere with debuggers and test frameworks. NSSetUncaughtExceptionHandler
        // covers ObjC/Swift exceptions; signal handlers add SIGABRT/SIGSEGV coverage.
    }

    public var isInitialized: Bool {
        lock.lock()
        defer { lock.unlock() }
        return _isInitialized
    }

    // MARK: - Signal Handlers

    /// Enable signal-based crash detection for SIGABRT, SIGSEGV, SIGBUS, etc.
    /// Call after `initialize()` in production apps. Not recommended during testing
    /// or debugging as signal handlers interfere with debuggers and XCTest.
    public func enableSignalHandlers() {
        setupSignalCrashFile()
        installSignalHandlers()
        checkPreviousSignalCrash()
    }

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
            // Store previous handler for chaining (skip SIG_DFL/SIG_ERR/SIG_IGN
            // which are sentinel values, not real function pointers).
            // Use unsafeBitCast since @convention(c) function pointers
            // don't conform to Equatable.
            if idx >= 0, idx < previousSignalHandlers.count {
                let prevRaw = unsafeBitCast(prev, to: Int.self)
                let dflRaw = unsafeBitCast(SIG_DFL, to: Int.self)
                let errRaw = unsafeBitCast(SIG_ERR, to: Int.self)
                let ignRaw = unsafeBitCast(SIG_IGN, to: Int.self)
                if prevRaw != dflRaw, prevRaw != errRaw, prevRaw != ignRaw {
                    previousSignalHandlers[idx] = prev
                }
            }
        }
    }

    // MARK: - Exception Handler

    // Internal so tests can deliver an exception to an isolated test instance,
    // without invoking the process-global routing handler or installing it.
    func handleException(_ exception: NSException) {
        // Still chain to previous handler even when disabled, but skip telemetry
        let enabled = AutoMobileSDK.shared.isEnabled

        lock.lock()
        let initialized = _isInitialized
        let configuredBundleId = bundleId
        let currentBuffer = buffer
        let previousHandler = previousExceptionHandler
        // Snapshot the provider under the lock; invoke it below, outside the lock,
        // so the (host-supplied) closure can never re-enter the non-recursive lock.
        let screenProvider = _currentScreenProvider
        lock.unlock()

        if enabled, initialized {
            let currentBundleId = configuredBundleId ?? Bundle.main.bundleIdentifier ?? ""
            let currentScreen = screenProvider?()
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
        }

        // Chain to previous handler
        previousHandler?(exception)
    }

    // MARK: - Testing Support

    func reset() {
        lifecycleLock.lock()

        lock.lock()
        // If we were never initialized (e.g. host opted out via
        // enableCrashReporting: false, or shutdown() is called a second time),
        // do nothing — we never installed a handler, and clobbering the
        // current handler would destroy the host app's crash reporter.
        guard _isInitialized else {
            lock.unlock()
            lifecycleLock.unlock()
            return
        }
        _isInitialized = false
        bundleId = nil
        buffer = nil
        let prevHandler = previousExceptionHandler
        let previousScreenProvider = _currentScreenProvider
        // Direct backing-field write: we already hold `lock` here, and the computed
        // `currentScreenProvider` setter would re-acquire the non-recursive lock.
        _currentScreenProvider = nil
        // Note: signal handlers cannot be safely uninstalled, leave installedSignalHandlers as-is
        lock.unlock()

        let currentHandler = captureUncaughtHandler()
        let ownsCurrentHandler = Self.isOwnHandler(currentHandler)
        let retainedInChain = currentHandler != nil && !ownsCurrentHandler

        lock.lock()
        exceptionHandlerRetainedInChain = retainedInChain
        if !retainedInChain {
            previousExceptionHandler = nil
        }
        lock.unlock()

        // A foreign handler may chain through our now-dormant handler. Preserve
        // its predecessor so forwarding still reaches the original reporter.
        if ownsCurrentHandler {
            installUncaughtHandler(prevHandler)
        }
        // A nil current handler was intentionally cleared by the host. Leave it
        // alone and forget our predecessor: no process-handler chain reaches us.
        lifecycleLock.unlock()
        // A provider's deinit may re-enter lifecycle operations as well as state
        // getters, so release it after both locks have been released.
        withExtendedLifetime(previousScreenProvider) {}
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
        let cacheDir = NSSearchPathForDirectoriesInDomains(.cachesDirectory, .userDomainMask, true)
            .first ?? NSTemporaryDirectory()
        let filePath = (cacheDir as NSString).appendingPathComponent("automobile_last_signal_crash")
        signalCrashFilePath = strdup(filePath)
    }

    /// Check if the previous session ended with a signal crash.
    func checkPreviousSignalCrash() {
        guard AutoMobileSDK.shared.isEnabled else { return }
        guard let path = signalCrashFilePath else { return }

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
        InternalLogger.error("Previous session crashed with \(signalName)")
    }
}
