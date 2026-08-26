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
    public var frameContext: String?
}

extension RequestTapCoordinates: CommandPayload {}
