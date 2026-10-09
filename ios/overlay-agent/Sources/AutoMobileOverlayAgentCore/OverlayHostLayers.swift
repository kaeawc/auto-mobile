import Foundation

/// The overlay window's two hosting views, stacked (#10899). An open dialog has to take the page
/// out of the accessibility tree, and the XCUITest snapshot of a hosting view lists every SwiftUI
/// node in it whatever `accessibilityHidden` or `accessibilityElement(children: .ignore)` say. It
/// does honour UIKit's `accessibilityElementsHidden` and `accessibilityViewIsModal` on a view, as
/// it does on the app's windows under a fullscreen overlay, so the page and the layer above it are
/// separate hosting views that UIKit can hide independently.
enum OverlayHostLayer: Equatable, Sendable {
    /// The spec's tree and its anchor layer.
    case page
    /// Open dialogs and snackbars, the anchored nodes inside them, and the host dismiss control,
    /// which an open dialog must leave reachable.
    case top

    /// The layer whose view reported the hit rect `key` (see `reportFrame`): `dismiss` and
    /// `dismissBar` (host chrome), `modal.<index>` (an open dialog or snackbar) and
    /// `anchor.modal<index>…` (an anchored node inside one) are the top layer's; `content` and the
    /// page's `anchor.root…` are the page's.
    init(hitRectKey key: String) {
        let top = key == "dismiss" || key == "dismissBar" || key.hasPrefix("modal.") || key.hasPrefix("anchor.modal")
        self = top ? .top : .page
    }

    /// The layer a touch at `point` (window coordinates) belongs to. The top layer is drawn above
    /// the page, so it wins wherever one of its rects holds the point; nil passes the touch through
    /// to the app.
    static func owner(of point: CGPoint, hitRects: [String: CGRect]) -> OverlayHostLayer? {
        let holders = hitRects.filter { $0.value.contains(point) }.keys.map(OverlayHostLayer.init(hitRectKey:))
        if holders.contains(.top) { return .top }
        return holders.isEmpty ? nil : .page
    }
}

/// The UIKit accessibility flags the agent sets for a shown overlay.
struct OverlayHostAccessibility: Equatable, Sendable {
    /// `accessibilityElementsHidden` on the page's hosting view: an open dialog makes the page inert.
    let pageElementsHidden: Bool
    /// `accessibilityViewIsModal` on the top layer's hosting view, so its siblings are excluded too.
    let topIsModal: Bool
    /// Whether the app's own windows leave the accessibility tree: a fullscreen overlay covers the
    /// app, and so does an open dialog's scrim, which fills the overlay window whatever the
    /// placement. Floating and sheet overlays otherwise leave the app reachable.
    let coversApp: Bool

    static let hidden = OverlayHostAccessibility(pageElementsHidden: false, topIsModal: false, coversApp: false)

    init(pageElementsHidden: Bool, topIsModal: Bool, coversApp: Bool) {
        self.pageElementsHidden = pageElementsHidden
        self.topIsModal = topIsModal
        self.coversApp = coversApp
    }

    /// The flags for `session` while the overlay window is shown (`windowShown`) or hidden.
    init(session: OverlaySession, windowShown: Bool) {
        guard windowShown, let spec = session.spec else {
            self = .hidden
            return
        }
        let dialogOpen = spec.root.blocksPage(state: session.state, pages: session.pages)
        self.init(
            pageElementsHidden: dialogOpen,
            topIsModal: dialogOpen,
            coversApp: dialogOpen || spec.window.placement.type == "fullscreen"
        )
    }
}
