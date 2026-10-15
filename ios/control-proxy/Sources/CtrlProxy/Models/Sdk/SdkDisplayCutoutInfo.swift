import Foundation

public struct SdkDisplayCutoutInfo: Codable, Sendable {
    public let classification: String
    public let bounds: [SdkBounds]?

    public init(classification: String, bounds: [SdkBounds]? = nil) {
        self.classification = classification
        self.bounds = bounds
    }
}
