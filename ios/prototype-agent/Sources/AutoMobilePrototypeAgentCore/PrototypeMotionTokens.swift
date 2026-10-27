import Foundation

/// Unit mass physical spring shared with Compose, independent of SwiftUI.
struct PrototypeMotionToken: Decodable, Equatable, Sendable {
    let dampingRatio: Double
    let stiffness: Double
    var mass: Double { 1 }
    var damping: Double { 2 * dampingRatio * sqrt(stiffness) }
    var overshoots: Bool { dampingRatio < 1 }
}

enum PrototypeMotionTokens {
    static func role(_ property: String) -> String {
        ["alpha", "background", "color", "border.color"].contains(property) ? "effects" : "spatial"
    }

    static func token(
        scheme: String = "standard",
        property: String,
        tempo: String = "default"
    )
        -> PrototypeMotionToken
    {
        PrototypeContractValidator.motionToken(scheme: scheme, role: role(property), tempo: tempo)
    }

    static func validate(_ data: [String: JSONValue], path: String) throws {
        if data["tempo"] != nil, data["durationMs"] != nil || data["easing"] != nil {
            throw PrototypeContractValidator.invalid(
                "\(path).tempo",
                "tempo cannot be combined with durationMs or easing"
            )
        }
    }
}
