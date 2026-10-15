import Foundation

public struct ScreenshotCapture: Sendable {
    public let data: Data
    public let rotation: Int?

    public init(data: Data, rotation: Int?) {
        self.data = data
        self.rotation = rotation
    }
}
