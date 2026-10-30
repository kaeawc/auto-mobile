import Foundation

/// The prototype window's two hosting views, stacked (#10899). An open dialog has to take the page
/// out of the accessibility tree, and the XCUITest snapshot of a hosting view lists every SwiftUI
/// node in it whatever `accessibilityHidden` or `accessibilityElement(children: .ignore)` say. It
/// does honour UIKit's `accessibilityElementsHidden` and `accessibilityViewIsModal` on a view, as
/// it does on the app's windows under a fullscreen prototype, so the page and the layer above it are
/// separate hosting views that UIKit can hide independently.
enum PrototypeHostLayer: Equatable, Sendable {
    /// The spec's tree and its anchor layer.
    case page
    /// Open dialogs, snackbars, menus, drawers, tooltips and bottom sheets, their anchored nodes,
    /// and the host dismiss control, which an open dialog must leave reachable.
    case top

    /// Host keys are `dismiss`, `dismissBar` and `escape`; `modal.select` is top-layer through `modal.`
    /// too, as are `modal.<index>` and `anchor.modal<index>…`; `content` and `anchor.root…` stay on page.
    init(hitRectKey key: String) {
        let top = key == "dismiss" || key == "dismissBar" || key == "escape" || key.hasPrefix("modal.") || key
            .hasPrefix("anchor.modal")
        self = top ? .top : .page
    }

    /// The layer a touch at `point` (window coordinates) belongs to. The top layer is drawn above
    /// the page, so it wins wherever one of its rects holds the point; nil passes the touch through
    /// to the app.
    static func owner(of point: CGPoint, hitRects: [String: CGRect]) -> PrototypeHostLayer? {
        let holders = hitRects.filter { $0.value.contains(point) }.keys.map(PrototypeHostLayer.init(hitRectKey:))
        if holders.contains(.top) { return .top }
        return holders.isEmpty ? nil : .page
    }
}

/// The UIKit accessibility flags the agent sets for a shown prototype.
struct PrototypeHostAccessibility: Equatable, Sendable {
    /// `accessibilityElementsHidden` on the page's hosting view: an open dialog makes the page inert.
    let pageElementsHidden: Bool
    /// `accessibilityViewIsModal` on the top layer's hosting view, so its siblings are excluded too.
    let topIsModal: Bool
    /// Whether the app's own windows leave the accessibility tree: a fullscreen prototype covers the
    /// app, and so does an open dialog's scrim, which fills the prototype window whatever the
    /// placement. Floating and sheet prototypes otherwise leave the app reachable.
    let coversApp: Bool

    /// Only chromeless fullscreen needs a root marker; other placements keep their dismiss marker.
    let windowMarked: Bool

    static let hidden = PrototypeHostAccessibility(pageElementsHidden: false, topIsModal: false, coversApp: false)

    init(pageElementsHidden: Bool, topIsModal: Bool, coversApp: Bool, windowMarked: Bool = false) {
        self.pageElementsHidden = pageElementsHidden
        self.topIsModal = topIsModal
        self.coversApp = coversApp
        self.windowMarked = windowMarked
    }

    /// The flags for `session` while the prototype window is shown (`windowShown`) or hidden.
    init(session: PrototypeSession, windowShown: Bool) {
        guard windowShown, session.isShown, let spec = session.spec else {
            self = .hidden
            return
        }
        let dialogOpen = spec.root.blocksPage(
            state: session.state,
            pages: session.pages,
            stacks: session.stacks,
            data: spec.data
        )
        self.init(
            pageElementsHidden: dialogOpen,
            topIsModal: dialogOpen,
            coversApp: dialogOpen || spec.window.placement.type == "fullscreen",
            windowMarked: PrototypeHostChrome(placementType: spec.window.placement.type, chrome: spec.window.chrome)
                .escape
        )
    }
}
