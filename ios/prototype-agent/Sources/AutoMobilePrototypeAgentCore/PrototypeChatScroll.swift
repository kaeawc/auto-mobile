import Foundation

/// Logical targets stay distinct from authored row keys such as "start" and "end".
enum PrototypeScrollTarget: Hashable, Sendable {
    case start, end, key(String)

    init?(_ value: JSONValue) {
        switch value {
        case .string("start"): self = .start
        case .string("end"): self = .end
        case let .object(fields):
            guard let value = fields["key"], let key = Self.scalarKey(value) else { return nil }
            self = .key(key)
        default: return nil
        }
    }

    static func scalarKey(_ value: JSONValue) -> String? {
        switch value {
        case .string, .number, .bool: value.displayString
        default: nil
        }
    }
}

struct PrototypeScrollRequest: Equatable, Sendable {
    let target: PrototypeScrollTarget
    let animated: Bool
    let sequence: Int
}

/// Device-free edge transitions. Geometry uses physical top-to-bottom coordinates on iOS;
/// reverse changes the initial anchor, never the order or the meaning of the two edges.
struct PrototypeChatScroll {
    private(set) var atEnd: Bool?
    private var atStart = false
    private var contentHeight: Double?

    struct Effects: Equatable {
        let atEnd: Bool?
        let reachedStart: Bool
        let followEnd: Bool
    }

    mutating func update(start: Double, end: Double, viewport: Double, stickToEnd: Bool) -> Effects {
        let height = end - start
        let grew = contentHeight.map { height > $0 } ?? false
        contentHeight = height
        // Keep the prior edge until the follow-up layout, avoiding a transient false atEnd write.
        if stickToEnd, atEnd == true, grew {
            return Effects(atEnd: nil, reachedStart: false, followEnd: true)
        }
        let nextEnd = end <= viewport + 0.5
        let nextStart = height > viewport + 0.5 && start >= -0.5
        let changedEnd = atEnd != nextEnd
        let reachedStart = nextStart && !atStart
        atEnd = nextEnd
        atStart = nextStart
        return Effects(atEnd: changedEnd ? nextEnd : nil, reachedStart: reachedStart, followEnd: false)
    }
}
