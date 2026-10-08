import Combine
import SwiftUI
import UIKit

/// Overlay state owned by the main thread. Transitions and event sequencing live in the
/// device-free `OverlaySession`; this adds SwiftUI publishing, assets and window geometry.
final class OverlayModel: ObservableObject {
    @Published private(set) var session = OverlaySession()
    @Published var safeInsets = UIEdgeInsets.zero
    var assets: [String: UIImage] = [:]

    /// Window-space rects that accept touches; everything else passes through to the app.
    var hitRects: [String: CGRect] = [:]

    var onEvent: (([String: Any]) -> Void)?
    var onVisibilityChange: ((Bool) -> Void)?

    var spec: OverlaySpec? {
        session.spec
    }

    var state: [String: JSONValue] {
        session.state
    }

    var pages: [String: Int] {
        session.pages
    }

    func show(_ spec: OverlaySpec) {
        // Keep the touchable rects: SwiftUI re-reports a frame only when it changes, so clearing
        // them on a same-geometry re-show would leave the overlay passing every touch through.
        session.show(spec)
        onVisibilityChange?(true)
    }

    func replace(_ spec: OverlaySpec) {
        session.replace(spec)
    }

    /// Asset changes must redraw: `assets` is not published, so notify observers explicitly.
    func putAsset(_ id: String, _ image: UIImage) {
        objectWillChange.send()
        assets[id] = image
    }

    func removeAsset(_ id: String) {
        guard assets[id] != nil else { return }
        objectWillChange.send()
        assets[id] = nil
    }

    func mergeState(_ values: [String: JSONValue]) {
        session.mergeState(values)
    }

    func holds(_ condition: Condition) -> Bool {
        session.holds(condition)
    }

    func missingAssets() -> [String] {
        session.missingAssets(available: Set(assets.keys))
    }

    // MARK: Interactions

    func run(_ actions: [OverlayAction]) {
        apply { $0.run(actions) }
    }

    func setPage(_ pager: String, _ target: Int) {
        apply { $0.setPage(pager, target) }
    }

    func toggle(_ key: String, then actions: [OverlayAction]) {
        apply { $0.toggle(key: key, then: actions) }
    }

    func select(index: Int, pager: String?, key: String?) {
        apply { $0.select(index: index, pager: pager, key: key) }
    }

    func dismiss(reason: OverlayDismissReason) {
        apply { $0.dismiss(reason: reason) }
    }

    /// Runs one session transition, pushes its events, and tears the window down when the
    /// transition ended the overlay.
    private func apply(_ transition: (inout OverlaySession) -> [OverlayEvent]) {
        let wasShown = session.isShown
        let events = transition(&session)
        let timestamp = Int(Date().timeIntervalSince1970 * 1000)
        for event in events {
            onEvent?(event.wireObject(timestamp: timestamp))
        }
        if wasShown, !session.isShown {
            hitRects = [:]
            onVisibilityChange?(false)
        }
    }

    func status() -> [String: Any] {
        [
            "shown": session.isShown,
            "id": spec?.id as Any? ?? NSNull(),
            "pages": pages,
            "state": JSONValue.object(state).foundationObject,
            "assets": assets.keys.sorted(),
        ]
    }

    /// Typing goes through `change`, so every edit both updates state and emits `change`.
    func binding(forStateKey key: String) -> Binding<String> {
        Binding(
            get: { self.state[key]?.displayString ?? "" },
            set: { value in self.apply { $0.change(key: key, value: .string(value)) } }
        )
    }
}
