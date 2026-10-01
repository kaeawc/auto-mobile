import Foundation

public struct RequestSwipe: Decodable, Sendable {
    public var requestId: String?
    public var x1: Double
    public var y1: Double
    public var x2: Double
    public var y2: Double
    public var duration: Int?
    public var frameContext: String?
    /// Optional client transport budget. Invalid or non-positive values leave the legacy path unchanged.
    public var timeoutMs: Int?

    private enum CodingKeys: String, CodingKey {
        case requestId, x1, y1, x2, y2, duration, frameContext, timeoutMs
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        requestId = try values.decodeIfPresent(String.self, forKey: .requestId)
        x1 = try values.decode(Double.self, forKey: .x1)
        y1 = try values.decode(Double.self, forKey: .y1)
        x2 = try values.decode(Double.self, forKey: .x2)
        y2 = try values.decode(Double.self, forKey: .y2)
        duration = try values.decodeIfPresent(Int.self, forKey: .duration)
        frameContext = try values.decodeIfPresent(String.self, forKey: .frameContext)
        let decodedTimeout = try? values.decode(Int.self, forKey: .timeoutMs)
        timeoutMs = decodedTimeout.flatMap { $0 > 0 ? $0 : nil }
    }
}

extension RequestSwipe: CommandPayload {}
