import Foundation

/// Screen navigation animation, shared by a stack and its push/replace overrides.
enum PrototypeStackTransition: String, Codable, CaseIterable {
    case platform, slide, fade, none, sharedAxisX, sharedAxisY, fadeThrough, zoom
}

enum PrototypeStackAnimation: Equatable {
    case slide, fade, none, sharedAxisX, sharedAxisY, fadeThrough
}

struct PrototypeStackEntry: Equatable, Identifiable {
    let id: Int
    let screen: String
}

struct PrototypeStackChange: Equatable {
    enum Direction { case push, pop, replace, reset }
    let direction: Direction
    let transition: PrototypeStackTransition
    let revision: Int
}

enum PrototypeStackNavigation {
    /// Spec motion disables all motion; system Reduce Motion substitutes a crossfade for travel.
    static func animation(
        declared: PrototypeStackTransition = .platform, perAction: PrototypeStackTransition? = nil,
        specMotion: String?, reduceMotion: Bool, direction: PrototypeStackChange.Direction = .push
    )
        -> PrototypeStackAnimation
    {
        let transition = perAction ?? declared
        let motion = PrototypeMotion(specMotion: specMotion, reduceMotion: reduceMotion)
        guard motion.enabled, transition != .none, direction != .reset else { return .none }
        if motion.fadeOnly || transition == .fade { return .fade }
        if transition == .platform || transition == .zoom, direction == .replace { return .fade }
        switch transition {
        case .sharedAxisX: return .sharedAxisX
        case .sharedAxisY: return .sharedAxisY
        case .fadeThrough: return .fadeThrough
        case .platform, .slide, .zoom: return .slide
        case .fade, .none: return .fade
        }
    }
}

/// Edge-pop geometry uses physical coordinates, independent of SwiftUI and the session.
enum PrototypeStackSwipe {
    static func isAtEdge(start: Double, width: Double, rtl: Bool) -> Bool {
        guard width > 0, start >= 0, start <= width else { return false }
        return rtl ? start >= width - 20 : start <= 20
    }

    static func distance(translation: Double, rtl: Bool) -> Double { translation * (rtl ? -1 : 1) }

    static func progress(translation: Double, width: Double, rtl: Bool) -> Double {
        guard width > 0 else { return 0 }
        return min(max(distance(translation: translation, rtl: rtl) / width, 0), 1)
    }

    /// SwiftUI's predicted translation incorporates release velocity without a clock or timer.
    static func commits(translation: Double, predicted: Double, width: Double, rtl: Bool) -> Bool {
        progress(translation: translation, width: width, rtl: rtl) > 0.5 ||
            progress(translation: predicted, width: width, rtl: rtl) > 0.5
    }
}

/// In-flight edge swipe only; completion animations belong to the renderer. Cancelling invalidates
/// the target and revision together, so a later end or an off-edge drag cannot reuse either.
struct PrototypeStackSwipeState {
    private(set) var target: String?
    private(set) var revision: Int?
    private(set) var progress = 0.0

    mutating func update(
        target: String, revision: Int, start: Double, translation: Double, vertical: Double,
        width: Double, rtl: Bool
    ) {
        if self.target == nil {
            guard PrototypeStackSwipe.isAtEdge(start: start, width: width, rtl: rtl),
                  abs(vertical) < abs(translation),
                  PrototypeStackSwipe.distance(translation: translation, rtl: rtl) > 0 else { return }
            self.target = target
            self.revision = revision
        }
        guard self.target == target, self.revision == revision else {
            cancel()
            return
        }
        progress = PrototypeStackSwipe.progress(translation: translation, width: width, rtl: rtl)
    }

    mutating func cancel() {
        target = nil
        revision = nil
        progress = 0
    }

    mutating func end() -> (target: String, revision: Int)? {
        defer { cancel() }
        guard let target, let revision else { return nil }
        return (target, revision)
    }
}

/// Fixed timings until the motion-token contract is available.
enum PrototypeStackTiming {
    static let spatial = 0.3
    static let effects = 0.15
}

enum PrototypeStackPatterns {
    static func sources(_ nodes: [PrototypeLocatedValue], actions: [PrototypeLocatedValue]) throws -> Set<String> {
        let zooms = actions.filter { action in
            let declared = nodes
                .first { $0.value["type"] == .string("stack") && $0.value["id"] == action.value["stack"] }
            return ["push", "replace"]
                .contains(action.value["type"]?.stringValue ?? "") &&
                (action.value["transition"] ?? declared?.value["transition"]) == .string("zoom")
        }
        for action in zooms {
            guard let source = action.value["source"]?.stringValue,
                  !source.contains("{"),
                  nodes
                  .filter({ ($0.value["shared"]?.objectFields?["key"] ?? $0.value["sharedKey"]) == .string(source) })
                  .count == 1
            else {
                throw PrototypeContractValidator.invalid(
                    "\(action.path).source",
                    "zoom requires source to resolve to exactly one sharedKey node"
                )
            }
        }
        return Set(zooms.compactMap { $0.value["source"]?.stringValue })
    }
}
