import Foundation

/// Compact metadata for a discoverable accessibility link in an observed element.
public struct SemanticLink: Codable, Equatable, Sendable {
    public let text: String
    public let occurrence: Int
    public let start: Int?
    public let end: Int?

    public init(text: String, occurrence: Int, start: Int? = nil, end: Int? = nil) {
        self.text = text
        self.occurrence = occurrence
        self.start = start
        self.end = end
    }
}
