import Foundation

/// Device-free drawer geometry and motion decisions. Dragging uses the sheet's half-extent settle rule.
enum PrototypeDrawers {
    static func isLeft(edge: String?, rightToLeft: Bool) -> Bool { (edge != "end") != rightToLeft }

    static func frame(window: CGRect, edge: String?, rightToLeft: Bool) -> CGRect {
        let width = max(0, min(320, window.width - 56))
        return CGRect(
            x: isLeft(edge: edge, rightToLeft: rightToLeft) ? window.minX : window.maxX - width,
            y: window.minY,
            width: width,
            height: window.height
        )
    }

    static func dismisses(
        width: Double,
        translation: Double,
        edge: String?,
        rightToLeft: Bool,
        dismissOnSwipe: Bool = true
    )
        -> Bool
    {
        let outward = translation * (isLeft(edge: edge, rightToLeft: rightToLeft) ? -1 : 1)
        return settlePrototypeSheet(
            heights: [width],
            current: width,
            drag: outward,
            dismissOnSwipe: dismissOnSwipe
        ) == nil
    }

    static func animation(specMotion: String?, reduceMotion: Bool) -> PrototypeStackAnimation {
        PrototypeStackNavigation.animation(specMotion: specMotion, reduceMotion: reduceMotion)
    }
}
