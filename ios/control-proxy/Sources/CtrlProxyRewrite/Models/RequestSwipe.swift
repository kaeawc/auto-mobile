import Foundation

public struct RequestSwipe: Decodable, Sendable {
    public var requestId: String?
    public var x1: Double
    public var y1: Double
    public var x2: Double
    public var y2: Double
    public var duration: Int?
    public var frameContext: String?
}

extension RequestSwipe: CommandPayload {}
