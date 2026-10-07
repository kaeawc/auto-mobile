import Foundation
import os
#if canImport(UIKit)
    import UIKit
#endif

/// Tracks handled (non-fatal) exceptions and errors.
/// iOS equivalent of Android's AutoMobileFailures.
public final class AutoMobileFailures: Sendable {
    public static let shared = AutoMobileFailures()

    private struct State: Sendable {
        var bundleId: String?
        var buffer: SdkEventBuffer?
        var events: [HandledExceptionEvent] = []
        var cachedDeviceInfo: SdkDeviceInfo?
        var cacheGeneration: UInt64 = 0
    }

    private let state = OSAllocatedUnfairLock(initialState: State())
    private let maxEvents = 100

    private init() {}

    func initialize(bundleId: String?, buffer: SdkEventBuffer) {
        state.withLock { state in
            state.bundleId = bundleId
            state.buffer = buffer
        }
    }

    /// Populate UIKit metadata without waiting for a host application's main thread.
    func cacheDeviceInfo(
        executor: any MainThreadExecuting = MainThreadExecutor(),
        deviceInfoProvider: @escaping @MainActor @Sendable () -> SdkDeviceInfo = {
            AutoMobileFailures.readDeviceInfo()
        }
    ) {
        let generation = state.withLock { $0.cacheGeneration }
        executor.execute {
            guard self.state.withLock({ $0.cacheGeneration == generation }) else { return }
            // Provider can re-enter failures; never call it while holding the lock.
            let deviceInfo = deviceInfoProvider()
            self.state.withLock {
                guard $0.cacheGeneration == generation else { return }
                $0.cachedDeviceInfo = deviceInfo
            }
        }
    }

    /// Record a handled exception/error.
    public func recordHandledException(
        _ error: Error,
        message: String? = nil,
        currentScreen: String? = nil
    ) {
        guard AutoMobileSDK.shared.isEnabled else { return }
        let nsError = error as NSError

        let (cachedDeviceInfo, currentBundleId) = state.withLock { state in
            (
                state.cachedDeviceInfo,
                state.bundleId ?? Bundle.main.bundleIdentifier ?? ""
            )
        }
        let deviceInfo = cachedDeviceInfo ?? Self.fallbackDeviceInfo()

        let event = HandledExceptionEvent(
            timestamp: Int64(Date().timeIntervalSince1970 * 1000),
            errorDomain: nsError.domain,
            errorMessage: nsError.localizedDescription,
            stackTrace: Thread.callStackSymbols.joined(separator: "\n"),
            customMessage: message,
            currentScreen: currentScreen,
            bundleId: currentBundleId,
            appVersion: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String,
            deviceInfo: deviceInfo
        )

        let currentBuffer = state.withLock { state in
            state.events.append(event)
            if state.events.count > maxEvents {
                state.events.removeFirst(state.events.count - maxEvents)
            }
            return state.buffer
        }

        InternalLogger
            .debug(
                "recordHandledException: domain=\(nsError.domain), buffer=\(currentBuffer != nil ? "exists" : "nil")"
            )
        let sdkEvent = SdkHandledExceptionEvent(
            timestamp: event.timestamp,
            errorDomain: event.errorDomain,
            errorMessage: event.errorMessage,
            stackTrace: event.stackTrace,
            customMessage: event.customMessage,
            currentScreen: event.currentScreen,
            bundleId: event.bundleId,
            appVersion: event.appVersion,
            deviceInfo: event.deviceInfo
        )
        currentBuffer?.add(sdkEvent)
    }

    /// Get recent handled exception events.
    public func getRecentEvents() -> [HandledExceptionEvent] {
        state.withLock { $0.events }
    }

    /// Clear all stored events.
    public func clearEvents() {
        state.withLock { $0.events.removeAll() }
    }

    /// Number of stored events.
    public var eventCount: Int {
        state.withLock { $0.events.count }
    }

    // MARK: - Device Info

    /// Event and crash reporting never wait for UIKit. If the cache lock is busy,
    /// crash reporting can still obtain platform metadata without waiting for it.
    static func currentDeviceInfo() -> SdkDeviceInfo {
        let cached = shared.state.withLockIfAvailable { $0.cachedDeviceInfo }
        return cached.flatMap { $0 } ?? fallbackDeviceInfo()
    }

    static func fallbackDeviceInfo() -> SdkDeviceInfo {
        var systemInfo = utsname()
        uname(&systemInfo)
        let machine = withUnsafePointer(to: &systemInfo.machine) {
            $0.withMemoryRebound(to: CChar.self, capacity: 1) {
                String(validatingCString: $0) ?? "Unknown"
            }
        }
        let systemName = withUnsafePointer(to: &systemInfo.sysname) {
            $0.withMemoryRebound(to: CChar.self, capacity: 1) {
                String(validatingCString: $0) ?? "Unknown"
            }
        }
        return SdkDeviceInfo(
            model: machine,
            osVersion: ProcessInfo.processInfo.operatingSystemVersionString,
            systemName: systemName == "Darwin" ? platformSystemName : systemName
        )
    }

    private static var platformSystemName: String {
        #if os(iOS)
            "iOS"
        #elseif os(tvOS)
            "tvOS"
        #elseif os(watchOS)
            "watchOS"
        #elseif os(visionOS)
            "visionOS"
        #else
            "macOS"
        #endif
    }

    @MainActor
    private static func readDeviceInfo() -> SdkDeviceInfo {
        #if canImport(UIKit) && !os(watchOS)
            let device = UIDevice.current
            return SdkDeviceInfo(
                model: device.model,
                osVersion: device.systemVersion,
                systemName: device.systemName
            )
        #else
            return fallbackDeviceInfo()
        #endif
    }

    // MARK: - Testing Support

    func reset() {
        state.withLock { state in
            state.bundleId = nil
            state.buffer = nil
            state.events.removeAll()
            state.cachedDeviceInfo = nil
            state.cacheGeneration &+= 1
        }
    }
}

// MARK: - HandledExceptionEvent

/// A recorded handled exception with context for debugging.
public struct HandledExceptionEvent: Sendable {
    public let timestamp: Int64
    public let errorDomain: String
    public let errorMessage: String?
    public let stackTrace: String
    public let customMessage: String?
    public let currentScreen: String?
    public let bundleId: String
    public let appVersion: String?
    public let deviceInfo: SdkDeviceInfo

    public init(
        timestamp: Int64,
        errorDomain: String,
        errorMessage: String?,
        stackTrace: String,
        customMessage: String?,
        currentScreen: String?,
        bundleId: String,
        appVersion: String?,
        deviceInfo: SdkDeviceInfo
    ) {
        self.timestamp = timestamp
        self.errorDomain = errorDomain
        self.errorMessage = errorMessage
        self.stackTrace = stackTrace
        self.customMessage = customMessage
        self.currentScreen = currentScreen
        self.bundleId = bundleId
        self.appVersion = appVersion
        self.deviceInfo = deviceInfo
    }
}
