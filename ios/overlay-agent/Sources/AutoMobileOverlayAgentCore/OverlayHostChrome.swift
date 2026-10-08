import Foundation

/// Host-owned chrome around a shown overlay, decided from the placement alone so the spec cannot
/// remove or cover it (#9307). Mirrors Android's `overlayHostChrome`: a fullscreen overlay gets a
/// dismiss bar across the top of the window, translucent and themed like the spec, only as tall as
/// its control (#10522), and the spec is laid out below it, so the control never covers authored
/// content and modal scrims never cover the control. Other placements keep the compact close
/// chip at the window's top trailing corner, outside their content.
struct OverlayHostChrome: Equatable {
    /// Whether the top of the window is reserved for the dismiss bar.
    let reservesDismissBar: Bool

    /// The control's side, the iOS minimum touch target (Android's bar holds a 32 dp text button).
    static let controlSide = 44.0

    init(placementType: String) {
        // Unknown placement types render fullscreen, so they get the bar too.
        reservesDismissBar = placementType != "sheet" && placementType != "floating"
    }

    /// The bar's height: the top safe-area inset it clears, plus the control.
    func dismissBarHeight(safeTop: Double) -> Double {
        reservesDismissBar ? safeTop + Self.controlSide : 0
    }

    /// The top inset `safeAreaPadding` sees inside the spec: the bar already clears the status bar
    /// and cutout, so content below it must not pad for them a second time.
    func contentSafeTop(safeTop: Double) -> Double {
        reservesDismissBar ? 0 : safeTop
    }

    /// The bar's background and content colours, as Android's `overlayDismissColors`: 60% white
    /// with near-black text on a light spec, 60% black with near-white text on a dark one.
    static func dismissBarColors(dark: Bool) -> (background: OverlayRGBA, content: OverlayRGBA) {
        dark
            ? (OverlayRGBA(red: 0, green: 0, blue: 0, alpha: 0x99 / 255), OverlayRGBA(rgb: 0xE6E6E6))
            : (OverlayRGBA(red: 1, green: 1, blue: 1, alpha: 0x99 / 255), OverlayRGBA(rgb: 0x1A1A1A))
    }
}

extension OverlayNode {
    /// Whether a `textField` is anywhere in this subtree, so focusing it is what the author meant.
    var containsTextField: Bool {
        type == "textField" || ((children ?? []) + [child].compactMap(\.self)).contains { $0.containsTextField }
    }
}

/// Whether a change in the open dialogs should drop keyboard focus in the overlay: a dialog opened
/// or closed, and the topmost open dialog (if any) has no text field. A focused picker wheel (a tap
/// on a wheel's selected row opens a number pad) or a field behind the dialog would otherwise keep
/// the keyboard up over the dialog's buttons; a dialog that holds a text field keeps focus so the
/// user can type into it. Snackbars never take focus, so only dialogs count.
func overlayModalChangeEndsEditing(from dialogsBefore: [ObjectIdentifier], to modalsAfter: [OverlayNode]) -> Bool {
    let dialogsAfter = modalsAfter.filter { $0.type == "dialog" }
    guard dialogsBefore != dialogsAfter.map(ObjectIdentifier.init) else { return false }
    return !(dialogsAfter.last?.containsTextField ?? false)
}

extension [OverlayNode] {
    /// Identities of the open dialogs among these modals, for `overlayModalChangeEndsEditing`.
    var dialogIdentities: [ObjectIdentifier] {
        filter { $0.type == "dialog" }.map(ObjectIdentifier.init)
    }
}
