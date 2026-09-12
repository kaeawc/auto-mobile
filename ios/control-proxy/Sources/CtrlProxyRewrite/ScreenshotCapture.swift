import Foundation

/// A screenshot and the device rotation sampled around the same capture operation.
///
/// `Sendable` (a `Data` + `Int?` value) so a `Sendable` `CommandHandler` (Phase 6) can
/// `await` `GesturePerforming.getScreenshotCapture()` on the main actor and carry the
/// result back across the isolation boundary. The reference type predated strict
/// concurrency and had no such annotation.
public struct ScreenshotCapture: Sendable {
    public let data: Data
    public let rotation: Int?

    public init(data: Data, rotation: Int?) {
        self.data = data
        self.rotation = rotation
    }
}
