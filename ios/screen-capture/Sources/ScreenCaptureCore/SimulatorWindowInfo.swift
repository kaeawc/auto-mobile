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
