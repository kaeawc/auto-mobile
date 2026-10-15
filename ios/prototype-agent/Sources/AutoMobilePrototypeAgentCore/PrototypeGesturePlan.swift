/// Gesture installation order, innermost first. Only authored, nonempty lists add layers.
struct PrototypeGesturePlan: Equatable, Sendable {
    enum Layer: Equatable, Sendable {
        case longPress, doubleTap, singleTap, tapResolver
    }

    let layers: [Layer]
    let consumesSingleTap: Bool
    let resolvesDoubleTapManually: Bool

    init(onTap: [PrototypeAction]?, onLongPress: [PrototypeAction]?, onDoubleTap: [PrototypeAction]?) {
        var layers: [Layer] = []
        if let onLongPress, !onLongPress.isEmpty { layers.append(.longPress) }
        consumesSingleTap = onTap?.isEmpty == false
        let hasDoubleTap = onDoubleTap?.isEmpty == false
        resolvesDoubleTapManually = consumesSingleTap && hasDoubleTap
        if resolvesDoubleTapManually {
            layers.append(.tapResolver)
        } else {
            if hasDoubleTap { layers.append(.doubleTap) }
            if consumesSingleTap { layers.append(.singleTap) }
        }
        self.layers = layers
    }
}

extension PrototypeNode {
    var gesturePlan: PrototypeGesturePlan {
        PrototypeGesturePlan(onTap: onTap, onLongPress: onLongPress, onDoubleTap: onDoubleTap)
    }
}
