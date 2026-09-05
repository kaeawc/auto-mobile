import Foundation

public struct RequestMultiFingerSwipe: Decodable, Sendable {
    public var requestId: String?
    public var x1: Double
    public var y1: Double
    public var x2: Double
    public var y2: Double
    public var fingerCount: Int?
    public var duration: Int?
    public var offset: Double?
}

extension RequestMultiFingerSwipe: CommandPayload {}
