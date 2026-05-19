import Foundation
import ScreenCaptureKit
import ScreenCaptureCore

enum SimulatorWindowDiscovery {
    /// Discovers visible iOS Simulator windows via ScreenCaptureKit.
    /// Requires screen-recording permission; throws if the user has not granted it.
    static func discover() async throws -> [SimulatorWindowInfo] {
        let content = try await SCShareableContent.excludingDesktopWindows(
            false,
            onScreenWindowsOnly: true
        )
        return content.windows
            .filter { $0.owningApplication?.bundleIdentifier == simulatorBundleIdentifier }
            .map(toInfo)
    }

    static func find(windowID: UInt32) async throws -> SCWindow? {
        let content = try await SCShareableContent.excludingDesktopWindows(
            false,
            onScreenWindowsOnly: true
        )
        return content.windows.first { $0.windowID == windowID }
    }

    static func toInfo(_ window: SCWindow) -> SimulatorWindowInfo {
        SimulatorWindowInfo(
            windowID: window.windowID,
            title: window.title,
            applicationName: window.owningApplication?.applicationName ?? "",
            bundleIdentifier: window.owningApplication?.bundleIdentifier ?? "",
            processID: window.owningApplication?.processID ?? 0,
            width: Int(window.frame.width),
            height: Int(window.frame.height)
        )
    }
}
