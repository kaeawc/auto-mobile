import Foundation

/// Pure card layout decisions for the renderer (`card` with an authored `style.width`).
enum PrototypeCardLayout {
    /// A card with `width: "fill"` draws its outline and fill across the whole node, as Compose's
    /// `Card` does. Any other width hugs the content, so its outline does too.
    static func outlineSpansWidth(_ width: Dimension?) -> Bool {
        if case .fill = width { return true }
        return false
    }
}
