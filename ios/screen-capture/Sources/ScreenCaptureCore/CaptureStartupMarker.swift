import Foundation

/// A stage in the iOS Simulator capture startup sequence, emitted on stderr so a
/// CI failure can be pinpointed to the stage that stalled.
///
/// The helper starts ScreenCaptureKit from a main-actor task while `RunLoop.main`
/// remains available. These markers are written synchronously to stderr around
/// each blocking call, so the last one observed identifies the stalled stage:
///
/// - `resolvingWindow` seen, `resolvedWindow` absent → stalled in window discovery
/// - `startingCapture` seen, `captureStarted` absent → stalled in `startCapture()`
/// - `captureStarted` seen, `firstFrame` absent      → started but delivered no frames
public enum CaptureStartupPhase: Equatable {
    case resolvingWindow(windowID: UInt32)
    case resolvedWindow(windowID: UInt32, width: Int, height: Int)
    case startingCapture(windowID: UInt32, fps: Int)
    case captureStarted(windowID: UInt32)
    case firstFrame(windowID: UInt32, width: Int, height: Int)
}

/// Formats {@link CaptureStartupPhase} into a stable, greppable stderr line.
public enum CaptureStartupMarker {
    /// Line prefix. Deliberately not `error:` — the TS supervisor
    /// (`IosH264Source`) treats an `error:`-prefixed line as a fatal helper error
    /// — and free of the `no frames received` token it matches as a permission
    /// denial. See `CaptureStartupMarkerTests`.
    public static let prefix = "capture-phase:"

    public static func line(_ phase: CaptureStartupPhase) -> String {
        switch phase {
        case let .resolvingWindow(windowID):
            return "\(prefix) resolving-window id=\(windowID)"
        case let .resolvedWindow(windowID, width, height):
            return "\(prefix) resolved-window id=\(windowID) size=\(width)x\(height)"
        case let .startingCapture(windowID, fps):
            return "\(prefix) starting-capture id=\(windowID) fps=\(fps)"
        case let .captureStarted(windowID):
            return "\(prefix) capture-started id=\(windowID)"
        case let .firstFrame(windowID, width, height):
            return "\(prefix) first-frame id=\(windowID) size=\(width)x\(height)"
        }
    }
}
