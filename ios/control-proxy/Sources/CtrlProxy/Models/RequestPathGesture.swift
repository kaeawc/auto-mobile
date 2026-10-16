import Foundation

/// One vertex of a single-finger path gesture: a screen point and when the finger reaches it.
public struct PathGesturePoint: Decodable, Equatable, Sendable {
    public var x: Double
    public var y: Double
    /// Milliseconds after the finger went down. A hold is two points at the same place.
    public var offsetMs: Int

    public init(x: Double, y: Double, offsetMs: Int) {
        self.x = x
        self.y = y
        self.offsetMs = offsetMs
    }
}

public struct RequestPathGesture: Decodable, Sendable {
    public var requestId: String?
    public var frameContext: String?
    public var points: [PathGesturePoint]
}

extension RequestPathGesture: CommandPayload {}

/// Pure validation for a path gesture, kept off-device so it is unit tested without XCTest.
public enum PathGesturePlan {
    public static let minPoints = 2
    public static let maxPoints = 2000
    /// Longest finger-down time accepted (matches the host's 20 s cap).
    public static let maxDurationMs = 20000

    /// Returns the points unchanged when they form a valid timeline, otherwise the reason.
    public static func validate(_ points: [PathGesturePoint]) throws -> [PathGesturePoint] {
        guard points.count >= minPoints else {
            throw CommandError.invalidParameter("points", "need at least \(minPoints) points, got \(points.count)")
        }
        guard points.count <= maxPoints else {
            throw CommandError.invalidParameter("points", "at most \(maxPoints) points, got \(points.count)")
        }
        guard points[0].offsetMs == 0 else {
            throw CommandError.invalidParameter("points[0].offsetMs", "\(points[0].offsetMs); the first point must be 0")
        }
        var previous = 0
        for (index, point) in points.enumerated() {
            guard point.x.isFinite, point.y.isFinite else {
                throw CommandError.invalidParameter("points[\(index)]", "(\(point.x), \(point.y)); must be finite")
            }
            guard point.offsetMs >= previous else {
                throw CommandError.invalidParameter(
                    "points[\(index)].offsetMs", "\(point.offsetMs); offsets must not decrease (previous \(previous))"
                )
            }
            previous = point.offsetMs
        }
        guard previous <= maxDurationMs else {
            throw CommandError.invalidParameter("points", "duration \(previous) ms exceeds \(maxDurationMs) ms")
        }
        return points
    }
}
