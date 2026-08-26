import Foundation

public struct RequestPinch: Decodable, Sendable {
    public var requestId: String?
    public var centerX: Double
    public var centerY: Double
    public var distanceStart: Double
    public var distanceEnd: Double
    public var rotationDegrees: Float?
    public var duration: Int?
}

extension RequestPinch: CommandPayload {}
