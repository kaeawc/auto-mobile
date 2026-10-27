import Foundation

/// Fixed timing values until the motion token table exists.
enum PrototypeKeyframeTiming {
    static let standard = (x1: 0.2, y1: 0.0, x2: 0.0, y2: 1.0)
    static let springDuration = 0.35
    static let springBounce = 0.15
    // Shared deterministic sampler shape, matching Android's damped ease.
    static let dampingRatio = 0.8
    static let stiffness = 380.0
}

/// Pure segment sampler. The normalized spring ease is deterministic and ends exactly at rest.
func keyframeValue(points: [(Double, Double)], curve: String, fraction: Double) -> Double {
    precondition(points.count >= 2)
    if fraction <= points[0].0 { return points[0].1 }
    if fraction >= points[points.count - 1].0 { return points[points.count - 1].1 }
    guard let end = points.firstIndex(where: { $0.0 >= fraction }) else { return points[points.count - 1].1 }
    let (a, av) = points[end - 1]
    let (b, bv) = points[end]
    let t = min(1, max(0, (fraction - a) / (b - a)))
    if t == 0 { return av }
    if t == 1 { return bv }
    let eased: Double
    switch curve {
    case "linear": eased = t
    case "spring":
        let rate = sqrt(PrototypeKeyframeTiming.stiffness) * PrototypeKeyframeTiming.dampingRatio
        eased = (1 - (1 + rate * t) * exp(-rate * t)) / (1 - (1 + rate) * exp(-rate))
    default:
        func cubic(_ u: Double, _ p1: Double, _ p2: Double) -> Double {
            3 * (1 - u) * (1 - u) * u * p1 + 3 * (1 - u) * u * u * p2 + u * u * u
        }
        var lo = 0.0
        var hi = 1.0
        let c = PrototypeKeyframeTiming.standard
        for _ in 0 ..< 32 {
            let mid = (lo + hi) / 2
            if cubic(mid, c.x1, c.x2) < t { lo = mid } else { hi = mid }
        }
        eased = cubic((lo + hi) / 2, c.y1, c.y2)
    }
    return av * (1 - eased) + bv * eased
}

enum PrototypeKeyframes {
    static func points(_ track: JSONValue) -> [(Double, Double)] {
        PrototypeStrictBindings.array(track.objectFields?["points"] ?? track).compactMap {
            let pair = PrototypeStrictBindings.array($0)
            guard pair.count == 2, let fraction = pair[0].numberValue, let value = pair[1].numberValue else {
                return nil
            }
            return (fraction, value)
        }
    }

    static func filtered(_ tracks: [String: JSONValue], profile: PrototypeMotionProfile) -> [String: JSONValue] {
        switch profile {
        case .off: [:]
        case .reduced: tracks.filter { $0.key == "alpha" }
        case .full: tracks
        }
    }

    static func validate(nodes: [PrototypeLocatedValue], spec: [String: JSONValue]) throws {
        for node in nodes {
            guard let frames = node.value["keyframes"]?.objectFields else { continue }
            let path = "\(node.path).keyframes"
            let trigger = frames["trigger"]?.objectFields ?? [:]
            if let key = trigger["key"]?.stringValue, spec["state"]?.objectFields?[key] == nil {
                throw PrototypeContractValidator.invalid("\(path).trigger.key", "Unknown state key")
            }
            if let pointer = trigger["data"]?.stringValue,
               PrototypeDataPointer.resolve(spec["data"]?.objectFields, pointer: pointer) == nil
            {
                throw PrototypeContractValidator.invalid("\(path).trigger.data", "Data pointer does not resolve")
            }
            for (name, track) in frames["tracks"]?.objectFields ?? [:] {
                let points = points(track)
                let at = "\(path).tracks.\(name)"
                let rest = name.hasPrefix("scale") || name == "alpha" ? 1.0 : 0.0
                if points[0].0 != 0 || points[points.count - 1].0 != 1 ||
                    zip(points, points.dropFirst()).contains(where: { $0.0 >= $1.0 }) ||
                    points.contains(where: { !(0 ... 1).contains($0.0) })
                {
                    throw PrototypeContractValidator.invalid(at, "Fractions must increase strictly from 0 to 1")
                }
                if points[0].1 != rest || points[points.count - 1].1 != rest {
                    throw PrototypeContractValidator.invalid(
                        at,
                        "First and last values must equal rest value \(Int(rest))"
                    )
                }
                if points
                    .contains(where: {
                        name == "alpha" ? !(0 ... 1).contains($0.1) : name.hasPrefix("scale") && $0.1 <= 0
                    })
                {
                    throw PrototypeContractValidator.invalid(
                        at,
                        "alpha must be in 0..1 and scale values must be positive"
                    )
                }
            }
        }
    }
}

/// Counts finite plays using the same injectable clock as other agent motion timers.
final class PrototypeKeyframeActivity {
    private let clock: PrototypeClock
    private var timers: [UUID: (token: UUID, handle: PrototypeTimerHandle)] = [:]
    var active: Int { timers.count }

    init(clock: PrototypeClock) { self.clock = clock }

    func play(owner: UUID, durationMs: Int) {
        stop(owner: owner)
        let token = UUID()
        let handle = clock.schedule(afterMilliseconds: durationMs) { [weak self] in
            guard let self, timers[owner]?.token == token else { return }
            timers.removeValue(forKey: owner)
        }
        timers[owner] = (token, handle)
    }

    func stop(owner: UUID) {
        timers.removeValue(forKey: owner)?.handle.cancel()
    }
}
