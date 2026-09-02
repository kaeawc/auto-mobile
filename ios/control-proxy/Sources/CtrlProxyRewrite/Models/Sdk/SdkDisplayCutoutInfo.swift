import Foundation

/// Physical display-cutout metadata reported by the SDK, distinct from the
/// aggregate safe-area edge insets. Duplicated from AutoMobileSDK since the two
/// packages share no dependency (ported from the reference target's
/// `SdkHierarchyModels.swift` for the display-cutout feature — #5787).
public struct SdkDisplayCutoutInfo: Codable, Sendable {
    public let classification: String
    public let bounds: [SdkBounds]?

    public init(classification: String, bounds: [SdkBounds]? = nil) {
        self.classification = classification
        self.bounds = bounds
    }
}
