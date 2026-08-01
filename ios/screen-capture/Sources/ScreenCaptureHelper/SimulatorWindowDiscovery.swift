import Foundation
import ScreenCaptureKit
import ScreenCaptureCore

/// Outcome of resolving a `CGWindowID` to a capturable window. `find` returns
/// this instead of a bare `SCWindow?` so the caller can distinguish a recycled
/// or unknown window id (`.notFound`) from a live window that is owned by some
/// other application (`.notSimulatorWindow`) and fail closed in both cases.
enum SimulatorWindowResolution {
    case resolved(SCWindow)
    case notFound
    case notSimulatorWindow(bundleIdentifier: String?)
}

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

    /// Resolves a `CGWindowID` and re-verifies at capture time that the window is
    /// still owned by the iOS Simulator. macOS recycles window IDs, so a stale
    /// `--simulator-window <id>` can point at an unrelated window (a browser,
    /// password manager, chat client); without this re-check the helper would
    /// capture it silently. The bundle-identifier predicate is shared with
    /// `discover()` via `isSimulatorWindow` so the two paths cannot drift (#4763).
    static func find(windowID: UInt32) async throws -> SimulatorWindowResolution {
        let content = try await SCShareableContent.excludingDesktopWindows(
            false,
            onScreenWindowsOnly: true
        )
        guard let window = content.windows.first(where: { $0.windowID == windowID }) else {
            return .notFound
        }
        let bundleIdentifier = window.owningApplication?.bundleIdentifier
        guard isSimulatorWindow(bundleIdentifier: bundleIdentifier) else {
            return .notSimulatorWindow(bundleIdentifier: bundleIdentifier)
        }
        return .resolved(window)
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
