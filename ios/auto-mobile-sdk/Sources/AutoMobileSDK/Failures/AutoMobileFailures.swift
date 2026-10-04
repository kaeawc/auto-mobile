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

    /// Cache device info from the main thread during SDK initialization.
    /// This avoids accessing UIDevice.current from background threads.
    func cacheDeviceInfo(
        deviceInfoProvider: @Sendable ()
            -> SdkDeviceInfo = { AutoMobileFailures.currentDeviceInfo() }
    ) {
        // UIKit reads may hop to main. Never hold the state lock across that hop.
        let deviceInfo = deviceInfoProvider()
        state.withLock { $0.cachedDeviceInfo = deviceInfo }
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
        let deviceInfo = cachedDeviceInfo ?? Self.currentDeviceInfo()

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

    static func currentDeviceInfo() -> SdkDeviceInfo {
        #if canImport(UIKit) && !os(watchOS)
            if Thread.isMainThread {
                // Assertion only after confirming main-thread execution, as in ViewHierarchyWalker.
                return MainActor.assumeIsolated { readDeviceInfo() }
            }
            return DispatchQueue.main.sync {
                MainActor.assumeIsolated { readDeviceInfo() }
            }
        #else
            var systemInfo = utsname()
            uname(&systemInfo)
            let machine = withUnsafePointer(to: &systemInfo.machine) {
                $0.withMemoryRebound(to: CChar.self, capacity: 1) {
                    String(validatingUTF8: $0) ?? "Unknown"
                }
            }
            return SdkDeviceInfo(
                model: machine,
                osVersion: ProcessInfo.processInfo.operatingSystemVersionString,
                systemName: "macOS"
            )
        #endif
    }

    #if canImport(UIKit) && !os(watchOS)
        @MainActor
        private static func readDeviceInfo() -> SdkDeviceInfo {
            let device = UIDevice.current
            return SdkDeviceInfo(
                model: device.model,
                osVersion: device.systemVersion,
                systemName: device.systemName
            )
        }
    #endif

    // MARK: - Testing Support

    func reset() {
        state.withLock { state in
            state.bundleId = nil
            state.buffer = nil
            state.events.removeAll()
            state.cachedDeviceInfo = nil
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
