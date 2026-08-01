import Foundation

/// Serializable description of an iOS Simulator window discovered via
/// ScreenCaptureKit. Emitted as JSON by `screen-capture-helper --list-simulators`.
public struct SimulatorWindowInfo: Codable, Equatable {
    public let windowID: UInt32
    public let title: String?
    public let applicationName: String
    public let bundleIdentifier: String
    public let processID: Int32
    public let width: Int
    public let height: Int

    public init(
        windowID: UInt32,
        title: String?,
        applicationName: String,
        bundleIdentifier: String,
        processID: Int32,
        width: Int,
        height: Int
    ) {
        self.windowID = windowID
        self.title = title
        self.applicationName = applicationName
        self.bundleIdentifier = bundleIdentifier
        self.processID = processID
        self.width = width
        self.height = height
    }
}

public struct SimulatorWindowListResponse: Codable, Equatable {
    public let windows: [SimulatorWindowInfo]

    public init(windows: [SimulatorWindowInfo]) {
        self.windows = windows
    }
}

/// Bundle identifier of the iOS Simulator host application on macOS.
public let simulatorBundleIdentifier = "com.apple.iphonesimulator"

/// Returns true when a window's owning-application bundle identifier belongs to
/// the iOS Simulator host. Used to re-verify a resolved `CGWindowID` at capture
/// time: macOS recycles window IDs, so a stale `--simulator-window <id>` can
/// resolve to an unrelated application's window. Re-checking here lets the
/// caller fail closed instead of silently capturing the wrong window (#4763).
public func isSimulatorWindow(bundleIdentifier: String?) -> Bool {
    bundleIdentifier == simulatorBundleIdentifier
}

/// ScreenCaptureKit cannot isolate a single Simulator window's audio from the
/// Simulator host application, so audio capture is safe only with one window.
public enum SimulatorAudioCaptureAvailability {
    public static func errorMessage(for visibleSimulatorWindows: [SimulatorWindowInfo]) -> String? {
        guard visibleSimulatorWindows.count > 1 else { return nil }
        return "iOS Simulator audio capture requires exactly one visible Simulator window because ScreenCaptureKit cannot isolate audio to a selected Simulator window. Close other Simulator windows and try again."
    }
}
