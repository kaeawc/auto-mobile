import Foundation

/// The bubble edge carrying the pointer; logical horizontal edges follow layout direction.
enum PrototypeCaret: String, Decodable { case auto, top, bottom, start, end }

struct PrototypePlacement: Equatable {
    let caret: PrototypeCaret
    let origin: CGPoint
    let caretOffset: CGFloat

    static func place(
        target: CGRect, bubble: CGSize, window: CGRect, rightToLeft: Bool = false,
        caret: PrototypeCaret = .auto, gap: CGFloat = 8, margin: CGFloat = 8, cornerRadius: CGFloat = 12
    )
        -> PrototypePlacement
    {
        let area = window.insetBy(dx: margin, dy: margin)
        let preferred = caret == .auto ? PrototypeCaret.top : caret
        let opposite: PrototypeCaret = switch preferred {
        case .auto, .top: .bottom
        case .bottom: .top
        case .start: .end
        case .end: .start
        }
        func room(_ side: PrototypeCaret) -> CGFloat {
            switch side {
            case .auto, .top: area.maxY - target.maxY - gap
            case .bottom: target.minY - area.minY - gap
            case .start: rightToLeft ? target.minX - area.minX - gap : area.maxX - target.maxX - gap
            case .end: rightToLeft ? area.maxX - target.maxX - gap : target.minX - area.minX - gap
            }
        }
        let vertical = preferred == .top || preferred == .bottom
        let extent = vertical ? bubble.height : bubble.width
        let resolved = room(preferred) >= extent ? preferred :
            (room(opposite) >= extent || room(opposite) > room(preferred) ? opposite : preferred)
        var origin = CGPoint(x: target.midX - bubble.width / 2, y: target.midY - bubble.height / 2)
        switch resolved {
        case .auto, .top: origin.y = target.maxY + gap
        case .bottom: origin.y = target.minY - gap - bubble.height
        case .start: origin.x = rightToLeft ? target.minX - gap - bubble.width : target.maxX + gap
        case .end: origin.x = rightToLeft ? target.maxX + gap : target.minX - gap - bubble.width
        }
        origin.x = clamp(origin.x, lower: area.minX, upper: area.maxX - bubble.width)
        origin.y = clamp(origin.y, lower: area.minY, upper: area.maxY - bubble.height)
        let length = vertical ? bubble.width : bubble.height
        let inset = min(cornerRadius, length / 2)
        let offset = vertical ? target.midX - origin.x : target.midY - origin.y
        return .init(
            caret: resolved,
            origin: origin,
            caretOffset: clamp(offset, lower: inset, upper: length - inset)
        )
    }

    static func menuOrigin(anchor: CGRect, surface: CGSize, window: CGSize, rightToLeft: Bool) -> CGPoint {
        let belowFits = anchor.maxY + surface.height <= window.height
        let aboveFits = anchor.minY >= surface.height
        let placement = place(
            target: anchor,
            bubble: surface,
            window: CGRect(origin: .zero, size: window),
            rightToLeft: rightToLeft,
            gap: 0,
            margin: 0
        )
        return CGPoint(
            x: clamp(
                rightToLeft ? anchor.minX : anchor.maxX - surface.width,
                lower: 0,
                upper: window.width - surface.width
            ),
            y: clamp(
                belowFits || aboveFits ? placement.origin.y : anchor.maxY,
                lower: 0,
                upper: window.height - surface.height
            )
        )
    }

    private static func clamp(_ value: CGFloat, lower: CGFloat, upper: CGFloat) -> CGFloat {
        min(max(value, lower), max(lower, upper))
    }
}
