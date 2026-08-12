import CoreGraphics

/// Requests Screen Recording only when the current process lacks the grant.
///
/// Keeping the CoreGraphics calls injectable makes the first-run permission
/// transition deterministic without invoking macOS privacy UI in unit tests.
public struct ScreenRecordingPermissionAccess {
    private let preflight: () -> Bool
    private let request: () -> Bool

    public init(
        preflight: @escaping () -> Bool = { CGPreflightScreenCaptureAccess() },
        request: @escaping () -> Bool = { CGRequestScreenCaptureAccess() }
    ) {
        self.preflight = preflight
        self.request = request
    }

    /// Returns true when access is already granted or the system request succeeds.
    public func requestIfNeeded() -> Bool {
        preflight() || request()
    }
}
