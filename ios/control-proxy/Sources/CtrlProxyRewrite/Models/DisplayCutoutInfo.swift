import Foundation

/// Physical display-cutout metadata, distinct from aggregate safe-area edge insets.
/// Merged into `ObservationInsetsInfo` and advertised to clients that opt in via the
/// `display_cutout_info` runner feature (#5787).
public struct DisplayCutoutInfo: Codable, Sendable {
    public let classification: String
    /// Bounds use the enclosing hierarchy's point coordinate system and rotation.
    public let bounds: [ElementBounds]?

    public init(classification: String, bounds: [ElementBounds]? = nil) {
        self.classification = classification
        self.bounds = bounds
    }

    public static let unknown = DisplayCutoutInfo(classification: "unknown", bounds: nil)
}
