import Foundation

/// Gesture recognizer info from the SDK.
public struct SdkGestureInfo: Codable, Sendable {
    public let type: String
    public let isEnabled: Bool

    public init(type: String, isEnabled: Bool) {
        self.type = type
        self.isEnabled = isEnabled
    }
}
