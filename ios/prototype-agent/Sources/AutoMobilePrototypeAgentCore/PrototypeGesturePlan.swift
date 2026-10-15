/// Gesture installation order, innermost first. Only authored, nonempty lists add layers.
struct PrototypeGesturePlan: Equatable, Sendable {
    enum Layer: Equatable, Sendable {
        case longPress, doubleTap, singleTap
    }

    let layers: [Layer]
    let consumesSingleTap: Bool

    init(onTap: [PrototypeAction]?, onLongPress: [PrototypeAction]?, onDoubleTap: [PrototypeAction]?) {
        var layers: [Layer] = []
        if let onLongPress, !onLongPress.isEmpty { layers.append(.longPress) }
        if let onDoubleTap, !onDoubleTap.isEmpty { layers.append(.doubleTap) }
        consumesSingleTap = onTap?.isEmpty == false
        if consumesSingleTap { layers.append(.singleTap) }
        self.layers = layers
    }
}

extension PrototypeNode {
    var gesturePlan: PrototypeGesturePlan {
        PrototypeGesturePlan(onTap: onTap, onLongPress: onLongPress, onDoubleTap: onDoubleTap)
    }
}
