import Foundation

/// Formats the user-facing approval target for a capture permission prompt.
/// It accompanies `CapturePermissionMarker`, rather than overloading its
/// stable permission vocabulary.
public enum CapturePermissionTargetMarker {
    public static let prefix = "capture-permission-target:"

    public static func line(_ target: String) -> String {
        "\(prefix) \(target)"
    }
}

/// Resolves the display name to show alongside a Screen Recording request.
///
/// The released helper is a signed bare executable, so it has neither an
/// `Info.plist` nor a user-facing process name. macOS presents that production
/// client as AutoMobile. Wrapped development configurations may provide their
/// own bundle display name.
public enum ScreenRecordingApprovalTarget {
    public static func resolve(
        bundleDisplayName: String?,
        bundleName: String?
    ) -> String {
        for candidate in [bundleDisplayName, bundleName] {
            let normalized = normalizedName(candidate)
            if !normalized.isEmpty {
                return normalized
            }
        }
        return "AutoMobile"
    }

    private static func normalizedName(_ name: String?) -> String {
        name?
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "\r", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }
}
