/// Gesture installation order, innermost first. Only authored, nonempty lists add layers.
struct PrototypeGesturePlan: Equatable, Sendable {
    enum Layer: Equatable, Sendable {
        case longPress, doubleTap, singleTap, tapResolver
    }

    /// A VoiceOver action for a gesture list that has no non-touch alternative otherwise (#15123).
    /// The single tap is the default activation, so only the two gesture lists name actions.
    enum AccessibilityAction: Equatable, Sendable {
        case longPress, doubleTap

        /// Fixed English defaults, like the escape pill's "Dismiss AutoMobile prototype".
        var name: String {
            switch self {
            case .longPress: "Long press"
            case .doubleTap: "Double tap"
            }
        }
    }

    let layers: [Layer]
    let accessibilityActions: [AccessibilityAction]
    let consumesSingleTap: Bool
    let resolvesDoubleTapManually: Bool

    init(onTap: [PrototypeAction]?, onLongPress: [PrototypeAction]?, onDoubleTap: [PrototypeAction]?) {
        var layers: [Layer] = []
        var accessibilityActions: [AccessibilityAction] = []
        if let onLongPress, !onLongPress.isEmpty {
            layers.append(.longPress)
            accessibilityActions.append(.longPress)
        }
        consumesSingleTap = onTap?.isEmpty == false
        let hasDoubleTap = onDoubleTap?.isEmpty == false
        if hasDoubleTap { accessibilityActions.append(.doubleTap) }
        resolvesDoubleTapManually = consumesSingleTap && hasDoubleTap
        if resolvesDoubleTapManually {
            layers.append(.tapResolver)
        } else {
            if hasDoubleTap { layers.append(.doubleTap) }
            if consumesSingleTap { layers.append(.singleTap) }
        }
        self.layers = layers
        self.accessibilityActions = accessibilityActions
    }
}

extension PrototypeNode {
    var gesturePlan: PrototypeGesturePlan {
        PrototypeGesturePlan(onTap: onTap, onLongPress: onLongPress, onDoubleTap: onDoubleTap)
    }
}
