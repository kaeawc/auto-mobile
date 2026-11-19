import Foundation

/// Pure card layout decisions for the renderer (`card` with an authored `style.width`).
enum PrototypeCardLayout {
    /// A card with `width: "fill"` draws its outline and fill across the whole node, as Compose's
    /// `Card` does. Any other width hugs the content, so its outline does too.
    static func outlineSpansWidth(_ width: Dimension?) -> Bool {
        if case .fill = width { return true }
        return false
    }

    /// A card with an authored `style.height` (`fill` or fixed points) draws its outline, fill and
    /// shadow across the whole frame, as Compose's `Card` does; `wrap` or no height hugs the content.
    static func outlineSpansHeight(_ height: Dimension?) -> Bool {
        switch height {
        case .fill, .points: return true
        default: return false
        }
    }
}
