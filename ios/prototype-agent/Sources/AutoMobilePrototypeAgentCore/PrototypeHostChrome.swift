import Foundation

/// Host-owned chrome around a shown prototype, decided from the placement alone so the spec cannot
/// remove or cover it (#9307). Mirrors Android's `prototypeHostChrome`: a fullscreen prototype gets a
/// dismiss bar across the top of the window, translucent and themed like the spec, only as tall as
/// its control (#10522), and the spec is laid out below it, so the control never covers authored
/// content and modal scrims never cover the control. Other placements keep the compact close
/// chip at the window's top trailing corner, outside their content.
struct PrototypeHostChrome: Equatable {
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

    /// The bar's translucency, as Android's `PROTOTYPE_DISMISS_BAR_ALPHA`.
    static let dismissBarAlpha = 0.6

    /// The bar's background and content colours, as Android's `prototypeDismissColors`:
    /// `surfaceContainerHigh` at 60% over `onSurface`. Host chrome always follows the palette; an
    /// unthemed spec resolves the baseline Material scheme for its light or dark mode.
    static func dismissBarColors(palette: PrototypePalette) -> (background: PrototypeRGBA, content: PrototypeRGBA) {
        var background = palette.chromeRole("surfaceContainerHigh")
        background.alpha = dismissBarAlpha
        return (background, palette.chromeRole("onSurface"))
    }

    /// The close chip's glyph and opaque fill (Android's `prototypeCloseColors`), so authored content
    /// cannot show through it.
    static func closeChipColors(palette: PrototypePalette) -> (glyph: PrototypeRGBA, fill: PrototypeRGBA) {
        (palette.chromeRole("onSurface"), palette.chromeRole("surfaceContainerHigh"))
    }
}

/// Colours for node fallbacks. Each is nil when the spec has no `theme`, so the renderer keeps the
/// iOS system colours there (they follow dark mode on their own).
extension PrototypePalette {
    private func themedRole(_ name: String) -> PrototypeRGBA? { themed ? colors[name] : nil }

    /// A resolved role; the palette always carries the whole baseline scheme.
    func chromeRole(_ name: String) -> PrototypeRGBA {
        colors[name] ?? PrototypeRGBA(red: 0, green: 0, blue: 0)
    }

    var sheetSurface: PrototypeRGBA? { themedRole("surface") }
    var sheetHandle: PrototypeRGBA? { themedRole("onSurfaceVariant") }
    var navSelected: PrototypeRGBA? { themedRole("onSecondaryContainer") }
    var navIndicator: PrototypeRGBA? { themedRole("secondaryContainer") }
    var navUnselected: PrototypeRGBA? { themedRole("onSurfaceVariant") }
    var placeholderFill: PrototypeRGBA? { themedRole("surfaceVariant") }
    var placeholderGlyph: PrototypeRGBA? { themedRole("onSurfaceVariant") }
}

extension PrototypeNode {
    /// Whether a `textField` is anywhere in this subtree, so focusing it is what the author meant.
    var containsTextField: Bool {
        type == "textField" || ((children ?? []) + [child].compactMap(\.self)).contains { $0.containsTextField }
    }
}

/// Whether a change in the open dialogs should drop keyboard focus in the prototype: a dialog opened
/// or closed, and the topmost open dialog (if any) has no text field. A focused picker wheel (a tap
/// on a wheel's selected row opens a number pad) or a field behind the dialog would otherwise keep
/// the keyboard up over the dialog's buttons; a dialog that holds a text field keeps focus so the
/// user can type into it. Snackbars never take focus, so only dialogs count.
func prototypeModalChangeEndsEditing(from dialogsBefore: [ObjectIdentifier], to modalsAfter: [PrototypeNode]) -> Bool {
    let dialogsAfter = modalsAfter.filter { $0.type == "dialog" }
    guard dialogsBefore != dialogsAfter.map(ObjectIdentifier.init) else { return false }
    return !(dialogsAfter.last?.containsTextField ?? false)
}

extension [PrototypeNode] {
    /// Identities of the open dialogs among these modals, for `prototypeModalChangeEndsEditing`.
    var dialogIdentities: [ObjectIdentifier] {
        filter { $0.type == "dialog" }.map(ObjectIdentifier.init)
    }
}
