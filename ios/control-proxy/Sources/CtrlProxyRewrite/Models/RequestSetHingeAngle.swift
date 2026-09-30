import Foundation

public struct RequestSetHingeAngle: Decodable, Sendable {
    public var requestId: String?
    public var angle: Double
}

extension RequestSetHingeAngle: CommandPayload {}
