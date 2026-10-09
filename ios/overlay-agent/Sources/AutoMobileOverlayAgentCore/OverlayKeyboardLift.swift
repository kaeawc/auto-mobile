import Foundation

/// Lifts a bottom `sheet` above the on-screen keyboard, as Android does (owner decision 2026-10-09,
/// docs/design-docs/plat/android/overlay-ux.md "Bottom sheet and the keyboard"). Device-free: the
/// agent feeds it the keyboard frame from UIKit's keyboard notifications.
enum OverlayKeyboardLift {
    /// Whether a placement moves for the keyboard: only a `sheet` against the bottom edge (an absent
    /// edge is the bottom, as in `OverlaySheetFrame`). Fullscreen, floating and top sheets never move.
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
        keyboardFrame: OverlayRect?,
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
    static func animationDuration(keyboardDuration: Double?, motion: OverlayMotion) -> Double? {
        guard motion.enabled, let keyboardDuration, keyboardDuration > 0 else { return nil }
        return keyboardDuration
    }
}
