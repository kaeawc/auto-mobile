import SwiftUI

// MARK: - Playground shapes

/// Chunky hand-drawn corner scale, mirroring the Android `AutoMobileShapes`. The
/// token-layer foundation of the crayon look; true irregular "wobble" borders are
/// layered on in the component phase. Values are corner radii in points.
struct PlaygroundShapes {
    let extraSmall: CGFloat = 6
    let small: CGFloat = 12
    let medium: CGFloat = 18
    let large: CGFloat = 26
    let extraLarge: CGFloat = 40

    // Component-specific radii
    let button: CGFloat = 14
    let card: CGFloat = 18
    let textField: CGFloat = 12
    let dialog: CGFloat = 26
    let bottomSheet: CGFloat = 26

    func rounded(_ radius: CGFloat) -> RoundedRectangle {
        RoundedRectangle(cornerRadius: radius, style: .continuous)
    }
}
