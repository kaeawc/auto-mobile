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

    /// Injectable `sigaction(2)` entry point (testing seam). Tests substitute a
    /// fake kernel table so the monitored fatal signals are never really re-routed.
    var sigactionCall: SigactionCall = { signalNumber, newAction, oldAction in
        sigaction(signalNumber, newAction, oldAction)
    }

    /// Signals this instance routes through the crash handler. Tests narrow it.
    var signalsToMonitor: [Int32] = AutoMobileCrashes.monitoredSignals

    func installSignalHandlers() {
        lifecycleLock.lock()
        defer { lifecycleLock.unlock() }

        lock.lock()
        guard !installedSignalHandlers else {
            lock.unlock()
            return
        }
        installedSignalHandlers = true
        lock.unlock()

        let table = autoMobileSignalTable
        table.recording.pointee = 1
        for sig in signalsToMonitor {
            installSignalHandler(for: sig, table: table)
        }
    }

    private func installSignalHandler(for sig: Int32, table: SignalHandlerTable) {
        let idx = Int(sig)
        guard idx > 0, idx < SignalHandlerTable.slotCount else { return }
        var current = sigaction()
        guard sigactionCall(sig, nil, &current) == 0 else {
            InternalLogger.warning("Could not read the current action for signal \(sig); leaving it alone")
            return
        }
        // Our handler already current (installed twice), or still linked into a later
        // reporter's chain after uninstall: keep the saved predecessor. Capturing the
        // current action as "previous" would create a handler cycle.
        guard !isOwnSignalAction(current), table.slotState[idx] == 0 else { return }

        table.previousActions[idx] = current
        table.slotState[idx] = 1
        table.ignoredOnce[idx] = 0
        var ours = sigaction()
        ours.__sigaction_u.__sa_sigaction = autoMobileSignalHandler
        ours.sa_mask = current.sa_mask
        ours.sa_flags = signalInstallFlags(previous: current)
        if sigactionCall(sig, &ours, nil) != 0 {
            table.slotState[idx] = 0
            InternalLogger.warning("Could not install the crash handler for signal \(sig)")
        }
    }

    /// Restore the saved actions, but only where our handler is still current. A
    /// reporter installed after us chains through our handler, so overwriting its
    /// registration would silently remove it: those slots stay linked, and the
    /// handler becomes a dormant forwarder because recording is switched off.
    func uninstallSignalHandlers() {
        lock.lock()
        guard installedSignalHandlers else {
            lock.unlock()
            return
        }
        installedSignalHandlers = false
        lock.unlock()

        let table = autoMobileSignalTable
        table.recording.pointee = 0
        for sig in signalsToMonitor {
            let idx = Int(sig)
            guard idx > 0, idx < SignalHandlerTable.slotCount, table.slotState[idx] != 0 else { continue }
            var current = sigaction()
            guard sigactionCall(sig, nil, &current) == 0, isOwnSignalAction(current) else { continue }
            var saved = table.previousActions[idx]
            if sigactionCall(sig, &saved, nil) == 0 {
                table.slotState[idx] = 0
            } else {
                InternalLogger.warning("Could not restore the previous action for signal \(sig)")
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
        let currentBuffer = buffer
        let currentBundleId = bundleId ?? Bundle.main.bundleIdentifier ?? ""
        let previousHandler = previousExceptionHandler
        // Snapshot the provider under the lock; invoke it below, outside the lock,
        // so the (host-supplied) closure can never re-enter the non-recursive lock.
        let screenProvider = _currentScreenProvider
        lock.unlock()

        if enabled, initialized {
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

        // Independent of exception-handler state: enableSignalHandlers() is public
        // and may have been called without initialize().
        uninstallSignalHandlers()

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

/// Three-argument `SA_SIGINFO` handler: `(signal, siginfo_t *, ucontext_t *)`.
typealias SignalInfoHandler = @convention(c) (Int32, UnsafeMutablePointer<siginfo_t>?, UnsafeMutableRawPointer?) -> Void

/// One-argument handler registered without `SA_SIGINFO`.
typealias SignalPlainHandler = @convention(c) (Int32) -> Void

/// `sigaction(2)` as an injectable function (see `AutoMobileCrashes.sigactionCall`).
typealias SigactionCall = (Int32, UnsafePointer<sigaction>?, UnsafeMutablePointer<sigaction>?) -> Int32

/// What the crash handler does with the action that was registered before ours.
enum SignalChainAction {
    /// Previous action had `SA_SIGINFO`: call it with all three arguments.
    case invokeSigInfo(SignalInfoHandler)
    /// Previous action was a plain one-argument handler.
    case invokePlain(SignalPlainHandler)
    /// Previous action was `SIG_IGN`.
    case ignore
    /// Previous action was `SIG_DFL` (or unusable): restore the default and re-raise.
    case restoreDefaultAndReraise
}

private let sigDflRaw = 0
private let sigIgnRaw = 1
private let sigErrRaw = -1

/// Decide how to chain to `previous`, exactly as the kernel would have dispatched
/// it. `SA_SIGINFO` selects the union member: reading `sa_handler` of an
/// `SA_SIGINFO` action (or vice versa) is what broke crash reporters (#10141).
func chainAction(forPrevious previous: sigaction) -> SignalChainAction {
    if previous.sa_flags & SA_SIGINFO != 0 {
        guard let handler = previous.__sigaction_u.__sa_sigaction else { return .restoreDefaultAndReraise }
        return .invokeSigInfo(handler)
    }
    let raw = unsafeBitCast(previous.__sigaction_u.__sa_handler, to: Int.self)
    switch raw {
    case sigDflRaw, sigErrRaw: return .restoreDefaultAndReraise
    case sigIgnRaw: return .ignore
    default:
        guard let handler = previous.__sigaction_u.__sa_handler else { return .restoreDefaultAndReraise }
        return .invokePlain(handler)
    }
}

/// Flags for our registration. Always `SA_SIGINFO` (we forward `siginfo_t`) and
/// `SA_ONSTACK` (a no-op unless the thread has an alternate stack, but required to
/// run on it for stack-overflow faults, which reporters arrange); `SA_NODEFER` is
/// inherited. `SA_RESETHAND` is not: it would uninstall us on the first signal, so
/// the chain emulates it instead.
func signalInstallFlags(previous: sigaction) -> Int32 {
    SA_SIGINFO | SA_ONSTACK | (previous.sa_flags & SA_NODEFER)
}

/// Whether `action` is our crash handler.
func isOwnSignalAction(_ action: sigaction) -> Bool {
    guard action.sa_flags & SA_SIGINFO != 0, let handler = action.__sigaction_u.__sa_sigaction else { return false }
    let ours: SignalInfoHandler = autoMobileSignalHandler
    return unsafeBitCast(handler, to: UnsafeRawPointer.self) == unsafeBitCast(ours, to: UnsafeRawPointer.self)
}

/// All state the signal handler touches, allocated once up front so the handler
/// never allocates, takes a lock, or goes through Swift's exclusivity-checked
/// global variables. Every field is a `let`; only pointee memory changes.
/// Writers are the install/uninstall paths; the handler only reads (plus the
/// re-entrancy counter and one-shot flags), accepting benign races.
final class SignalHandlerTable: @unchecked Sendable {
    static let slotCount = 64
    static let pathCapacity = 1024

    /// Saved previous action per signal number.
    let previousActions: UnsafeMutablePointer<sigaction>
    /// 0 = nothing saved (default behaviour), 1 = `previousActions` is valid.
    let slotState: UnsafeMutablePointer<UInt8>
    /// Set once a `SIG_IGN` predecessor was honoured for this signal.
    let ignoredOnce: UnsafeMutablePointer<UInt8>
    /// NUL-terminated crash-file path.
    let pathBuffer: UnsafeMutablePointer<CChar>
    let pathReady: UnsafeMutablePointer<Int32>
    /// 1 while the SDK is enabled; 0 makes the handler a pure forwarder.
    let recording: UnsafeMutablePointer<Int32>
    /// Handler nesting depth (crash while handling a crash).
    let depth: UnsafeMutablePointer<Int32>

    init() {
        previousActions = .allocate(capacity: Self.slotCount)
        previousActions.initialize(repeating: sigaction(), count: Self.slotCount)
        slotState = .allocate(capacity: Self.slotCount)
        slotState.initialize(repeating: 0, count: Self.slotCount)
        ignoredOnce = .allocate(capacity: Self.slotCount)
        ignoredOnce.initialize(repeating: 0, count: Self.slotCount)
        pathBuffer = .allocate(capacity: Self.pathCapacity)
        pathBuffer.initialize(repeating: 0, count: Self.pathCapacity)
        pathReady = .allocate(capacity: 1)
        pathReady.initialize(to: 0)
        recording = .allocate(capacity: 1)
        recording.initialize(to: 0)
        depth = .allocate(capacity: 1)
        depth.initialize(to: 0)
    }

    /// Copy `path` into the pre-allocated buffer. Returns false when it does not fit.
    func setCrashFilePath(_ path: String) -> Bool {
        pathReady.pointee = 0
        let length = path.withCString { strlcpy(pathBuffer, $0, Self.pathCapacity) }
        guard length < Self.pathCapacity else { return false }
        pathReady.pointee = 1
        return true
    }

    /// Forget everything. Tests only.
    func resetForTesting() {
        previousActions.update(repeating: sigaction(), count: Self.slotCount)
        slotState.update(repeating: 0, count: Self.slotCount)
        ignoredOnce.update(repeating: 0, count: Self.slotCount)
        pathReady.pointee = 0
        recording.pointee = 0
        depth.pointee = 0
    }
}

/// Process-global table. Touched at install time so lazy initialization has
/// completed before the handler can ever run.
let autoMobileSignalTable = SignalHandlerTable()

/// Global handler for signal-based faults (SIGABRT, SIGSEGV, etc.), registered
/// with `sigaction` + `SA_SIGINFO`. Only async-signal-safe work: `open`/`write`/
/// `close` of the pre-allocated path, `sigaction`/`pthread_sigmask`/`raise`, and
/// raw memory reads. Then it chains to the previous action with the arguments
/// that action expects.
func autoMobileSignalHandler(
    _ sig: Int32,
    _ info: UnsafeMutablePointer<siginfo_t>?,
    _ context: UnsafeMutableRawPointer?
) {
    let table = autoMobileSignalTable
    // A fault inside this handler (possibly a different signal, or the same one
    // under SA_NODEFER): do not record or chain again, just die by the signal.
    guard table.depth.pointee == 0 else {
        restoreDefaultAndReraise(sig)
        return
    }
    table.depth.pointee += 1
    defer { table.depth.pointee -= 1 }

    if table.recording.pointee != 0, table.pathReady.pointee != 0 {
        recordSignal(sig, path: table.pathBuffer)
    }

    let idx = Int(sig)
    guard idx > 0, idx < SignalHandlerTable.slotCount, table.slotState[idx] != 0 else {
        restoreDefaultAndReraise(sig)
        return
    }
    let previous = table.previousActions[idx]
    switch chainAction(forPrevious: previous) {
    case let .invokeSigInfo(handler):
        resetToDefaultIfRequested(previous, sig: sig)
        handler(sig, info, context)
    case let .invokePlain(handler):
        resetToDefaultIfRequested(previous, sig: sig)
        handler(sig)
    case .ignore:
        // Honour SIG_IGN once. A synchronous fault re-executes after we return and
        // would loop forever, so a second delivery escalates to the default.
        if table.ignoredOnce[idx] != 0 {
            restoreDefaultAndReraise(sig)
        } else {
            table.ignoredOnce[idx] = 1
        }
    case .restoreDefaultAndReraise:
        restoreDefaultAndReraise(sig)
    }
}

private func recordSignal(_ sig: Int32, path: UnsafeMutablePointer<CChar>) {
    let fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0o644)
    guard fd >= 0 else { return }
    var sigValue = sig
    _ = Darwin.write(fd, &sigValue, MemoryLayout<Int32>.size)
    close(fd)
}

/// The kernel resets a `SA_RESETHAND` action to `SIG_DFL` before invoking it;
/// emulate that, since we are standing in for the action.
private func resetToDefaultIfRequested(_ previous: sigaction, sig: Int32) {
    guard previous.sa_flags & SA_RESETHAND != 0 else { return }
    setDefaultAction(sig)
}

private func setDefaultAction(_ sig: Int32) {
    var action = sigaction()
    action.__sigaction_u.__sa_handler = SIG_DFL
    _ = sigaction(sig, &action, nil)
}

/// Restore the default action and re-deliver so the process dies with the right
/// signal and exit status. The signal is blocked while we run, so unblock it.
private func restoreDefaultAndReraise(_ sig: Int32) {
    setDefaultAction(sig)
    var set = sigset_t()
    sigemptyset(&set)
    sigaddset(&set, sig)
    _ = pthread_sigmask(SIG_UNBLOCK, &set, nil)
    raise(sig)
}

// MARK: - Previous Signal Crash Detection

extension AutoMobileCrashes {
    /// Set up the file path for signal crash persistence.
    func setupSignalCrashFile() {
        let cacheDir = NSSearchPathForDirectoriesInDomains(.cachesDirectory, .userDomainMask, true)
            .first ?? NSTemporaryDirectory()
        let filePath = (cacheDir as NSString).appendingPathComponent("automobile_last_signal_crash")
        if !autoMobileSignalTable.setCrashFilePath(filePath) {
            InternalLogger.warning("Signal crash file path is too long; signal crashes will not be recorded")
        }
    }

    private static func signalName(for value: Int32) -> String {
        switch value {
        case SIGABRT: "SIGABRT"
        case SIGSEGV: "SIGSEGV"
        case SIGBUS: "SIGBUS"
        case SIGFPE: "SIGFPE"
        case SIGILL: "SIGILL"
        case SIGTRAP: "SIGTRAP"
        default: "SIGNAL(\(value))"
        }
    }

    /// Check if the previous session ended with a signal crash.
    func checkPreviousSignalCrash() {
        guard AutoMobileSDK.shared.isEnabled else { return }
        let table = autoMobileSignalTable
        guard table.pathReady.pointee != 0 else { return }
        let path = table.pathBuffer

        let fd = open(path, O_RDONLY)
        guard fd >= 0 else { return }

        var sigValue: Int32 = 0
        let bytesRead = Darwin.read(fd, &sigValue, MemoryLayout<Int32>.size)
        close(fd)
        unlink(path) // Remove the file after reading

        guard bytesRead == MemoryLayout<Int32>.size, sigValue != 0 else { return }

        let signalName = Self.signalName(for: sigValue)

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
