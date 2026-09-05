import Foundation

/// A single inline semantic link the in-app SDK discovered on a text element,
/// as decoded from the SDK's hierarchy payload (issue #5560). Mirrors the SDK's
/// `SdkSemanticLink` wire shape: the Android-parity `text`/`occurrence`/range plus
/// the iOS-only optional on-screen center point used for coordinate activation.
public struct SdkSemanticLink: Codable, Sendable, Equatable {
    public let text: String
    public let occurrence: Int
    public let start: Int?
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
