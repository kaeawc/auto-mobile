import Foundation

/// Screen navigation animation, shared by a stack and its push/replace overrides.
enum PrototypeStackTransition: String, Codable, CaseIterable {
    case platform, slide, fade, none
}

enum PrototypeStackAnimation: Equatable {
    case slide, fade, none
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
        guard specMotion != "none", transition != .none, direction != .reset else { return .none }
        if reduceMotion || transition == .fade || (transition == .platform && direction == .replace) { return .fade }
        return .slide
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
