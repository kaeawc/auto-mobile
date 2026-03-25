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
    }

    public var isInitialized: Bool {
        lock.lock()
        defer { lock.unlock() }
        return _isInitialized
    }

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
        lock.unlock()
    }
}
