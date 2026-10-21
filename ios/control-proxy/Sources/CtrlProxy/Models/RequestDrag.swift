import Foundation

public struct RequestDrag: Decodable, Sendable {
    public var requestId: String?
    public var x1: Double
    public var y1: Double
    public var x2: Double
    public var y2: Double
    public var pressDurationMs: Int?
    public var dragDurationMs: Int?
    public var holdDurationMs: Int?
    public var holdTime: Int?
    public var frameContext: String?
}

extension RequestDrag: CommandPayload {}
