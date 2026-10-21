import Foundation

public struct RequestSetHingeAngle: Decodable, Sendable {
    public var requestId: String?
    public var angle: Double
}

extension RequestSetHingeAngle: CommandPayload {}

/// Simulate the device location through XCUITest (#14091): a fix from `latitude`/`longitude`
/// (optional `altitude` meters, `horizontalAccuracy` meters), or `clear: true` to restore the
/// real location.
public struct RequestLocation: Decodable, Sendable {
    public var requestId: String?
    public var latitude: Double?
    public var longitude: Double?
    public var altitude: Double?
    public var horizontalAccuracy: Double?
    public var clear: Bool?
}

extension RequestLocation: CommandPayload {}
