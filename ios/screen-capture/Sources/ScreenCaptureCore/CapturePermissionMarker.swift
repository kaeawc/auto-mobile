import Foundation

/// A macOS privacy permission the helper requires for a capture operation.
///
/// The raw TCC and ScreenCaptureKit failures vary by macOS release. This stable
/// vocabulary lets the supervising daemon present product-specific recovery
/// guidance without parsing those diagnostics.
public enum CapturePermission: String {
    case screenRecording = "screen-recording"
}

/// Formats a `CapturePermission` into a stable stderr line consumed by the
/// TypeScript supervisor:
///
///     capture-permission: screen-recording
public enum CapturePermissionMarker {
    public static let prefix = "capture-permission:"

    public static func line(_ permission: CapturePermission) -> String {
        "\(prefix) \(permission.rawValue)"
    }
}
