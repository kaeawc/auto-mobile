import Foundation

/// A drag that starts on a SpringBoard icon (home screen grid or dock) never lifts it on iOS 27.2:
/// both the XCUICoordinate press-then-drag and the synthesized `XCPointerEventPath` stroke, and
/// even HID digitizer touches, open the icon's context menu and drop the moves (#18859). The runner
/// refuses such a stroke before any input instead of reporting a success that moved nothing.
///
/// SpringBoard keeps icon views in its tree while an app covers them, so a frame match alone is
/// only a candidate; the caller confirms the candidate is hittable at the point.
enum SpringBoardIconHit {
    struct Icon: Equatable {
        let identifier: String
        let label: String
        let frame: CGRect
    }

    /// Icons whose frame contains `point`, smallest first (a folder icon encloses nothing, but a
    /// zero-size or offscreen-page icon never qualifies).
    static func candidates(at point: CGPoint, in icons: [Icon]) -> [Icon] {
        icons
            .filter { $0.frame.width > 0 && $0.frame.height > 0 && $0.frame.contains(point) }
            .sorted { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }
    }

    /// Name used in the refusal: the icon's label, else its identifier, else a generic word.
    static func displayName(_ icon: Icon) -> String {
        if !icon.label.isEmpty { return icon.label }
        if !icon.identifier.isEmpty { return icon.identifier }
        return "a SpringBoard icon"
    }
}
