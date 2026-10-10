import Foundation

/// Lifts a bottom `sheet` above the on-screen keyboard, as Android does (owner decision 2026-10-09,
/// docs/design-docs/plat/android/prototype-ux.md "Bottom sheet and the keyboard"). Device-free: the
/// agent feeds it the keyboard frame from UIKit's keyboard notifications.
///
/// Exactly one mechanism moves the sheet: `amount`, applied as bottom padding inside a full-window
/// frame. The hosting controllers keep no keyboard safe area (`hostSafeAreaRegions`), so neither
/// UIKit nor SwiftUI can add its own keyboard inset on top of it (#11042: on an iOS 26.5 simulator a
/// 300 pt sheet moved 527 pt where this lift was 334 pt).
enum PrototypeKeyboardLift {
    /// The safe-area regions the prototype's hosting controllers apply to SwiftUI layout: none. The
    /// window's container insets reach the spec only through `safeAreaPadding` (the model's window
    /// insets), and the keyboard only through `amount`. The agent maps this onto
    /// `UIHostingController.safeAreaRegions` for both the page and the top layer.
    static let hostSafeAreaRegions: PrototypeHostSafeAreaRegions = []

    /// Whether a placement moves for the keyboard: only a `sheet` against the bottom edge (an absent
    /// edge is the bottom, as in `PrototypeSheetFrame`). Fullscreen, floating and top sheets never move.
    static func appliesTo(placementType: String, edge: String?) -> Bool {
        placementType == "sheet" && edge != "top"
    }

    /// Points to raise the sheet: how far the keyboard's top edge reaches into the window, both in
    /// screen coordinates. Zero without a keyboard, for a keyboard below the window's bottom (a
    /// hardware keyboard reports a frame at or past the screen edge), or for a placement that
    /// does not move. Never more than the window is tall.
    static func amount(
        placementType: String,
        edge: String?,
        keyboardFrame: PrototypeRect?,
        windowOriginY: Double,
        windowHeight: Double
    )
        -> Double
    {
        guard appliesTo(placementType: placementType, edge: edge), let keyboardFrame,
              keyboardFrame.height > 0, windowHeight > 0 else { return 0 }
        let windowBottom = windowOriginY + windowHeight
        return Swift.min(Swift.max(windowBottom - keyboardFrame.y, 0), windowHeight)
    }

    /// Seconds to animate a lift change: the keyboard's own duration, or nil (instant) under spec
    /// `motion: "none"` or Reduce Motion, or when the keyboard reports none.
    static func animationDuration(keyboardDuration: Double?, motion: PrototypeMotion) -> Double? {
        guard motion.enabled, let keyboardDuration, keyboardDuration > 0 else { return nil }
        return keyboardDuration
    }
}

/// UIKit-free mirror of `UIHostingController.SafeAreaRegions`.
struct PrototypeHostSafeAreaRegions: OptionSet, Equatable {
    let rawValue: Int
    static let container = PrototypeHostSafeAreaRegions(rawValue: 1 << 0)
    static let keyboard = PrototypeHostSafeAreaRegions(rawValue: 1 << 1)
}
