import Foundation

/// A single inline accessibility link discovered on an owning text element.
///
/// Mirrors the Android `SemanticLink` contract (text + occurrence + optional
/// character range) so the merged AutoMobile hierarchy is shaped identically on
/// both platforms (issue #5560). `centerX`/`centerY` are an iOS-only addition:
/// the in-app SDK can compute a link's on-screen point, which the out-of-process
/// runner uses to activate a specific inline link by coordinate. They are dropped
/// when the node is projected to the Android-parity wire shape.
public struct SdkSemanticLink: Codable, Sendable, Equatable {
    public let text: String
    public let occurrence: Int
    /// UTF-16 offset (NSString semantics) of the link's first character, when the
    /// source is a real attributed string. `nil` for accessibility-element
    /// fallbacks (e.g. SwiftUI inline links) where no range is exposed.
    public let start: Int?
    /// UTF-16 offset one past the link's last character. `nil` when `start` is nil.
    public let end: Int?
    public let centerX: Double?
    public let centerY: Double?

    public init(
        text: String,
        occurrence: Int,
        start: Int? = nil,
        end: Int? = nil,
        centerX: Double? = nil,
        centerY: Double? = nil
    ) {
        self.text = text
        self.occurrence = occurrence
        self.start = start
        self.end = end
        self.centerX = centerX
        self.centerY = centerY
    }
}
