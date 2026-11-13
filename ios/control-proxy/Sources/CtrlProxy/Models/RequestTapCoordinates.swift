import Foundation

// Coordinate fields are `Double`, not `Int`: the iOS TS wire path runs with
// `roundCoordinates: false`, so a caller can legitimately send sub-pixel
// coordinates. `Double` decodes both integer and fractional JSON numbers (#2909).
// Durations, finger counts, and rotation stay in their original numeric types.
public struct RequestTapCoordinates: Decodable, Sendable {
    public var requestId: String?
    public var x: Double
    public var y: Double
    public var duration: Int?
    public var doubleTap: Bool?
    public var frameContext: String?
    public var diagnostics: Bool?
    // Keep unknown strings decodable; the performer logs and ignores them.
    public var tapStrategy: String?
    /// Optional client transport budget. Invalid or non-positive values keep the legacy path.
    public var timeoutMs: Int?

    private enum CodingKeys: String, CodingKey {
        case requestId, x, y, duration, doubleTap, frameContext, diagnostics, tapStrategy, timeoutMs
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        requestId = try values.decodeIfPresent(String.self, forKey: .requestId)
        x = try values.decode(Double.self, forKey: .x)
        y = try values.decode(Double.self, forKey: .y)
        duration = try values.decodeIfPresent(Int.self, forKey: .duration)
        doubleTap = try values.decodeIfPresent(Bool.self, forKey: .doubleTap)
        frameContext = try values.decodeIfPresent(String.self, forKey: .frameContext)
        diagnostics = try values.decodeIfPresent(Bool.self, forKey: .diagnostics)
        tapStrategy = try values.decodeIfPresent(String.self, forKey: .tapStrategy)
        let decodedTimeout = try? values.decode(Int.self, forKey: .timeoutMs)
        timeoutMs = decodedTimeout.flatMap { $0 > 0 ? $0 : nil }
    }
}

extension RequestTapCoordinates: CommandPayload {}
