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
    /// Resigns keyboard focus inside the overlay window.
    var onEndEditing: (() -> Void)?

    var spec: OverlaySpec? {
        session.spec
    }

    /// The safe-area insets `safeAreaPadding` sees inside the spec: a fullscreen spec sits below the
    /// host dismiss bar, which already clears the top inset.
    var contentSafeInsets: UIEdgeInsets {
        var insets = safeInsets
        let chrome = OverlayHostChrome(placementType: spec?.window.placement.type ?? "fullscreen")
        insets.top = chrome.contentSafeTop(safeTop: insets.top)
        return insets
    }

    var state: [String: JSONValue] {
        session.state
    }

    var pages: [String: Int] {
        session.pages
    }

    func show(_ spec: OverlaySpec, reset: Bool = false) {
        // Keep the touchable rects: SwiftUI re-reports a frame only when it changes, so clearing
        // them on a same-geometry re-show would leave the overlay passing every touch through.
        session.show(spec, reset: reset)
        onVisibilityChange?(true)
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

    func holds(_ condition: Condition) -> Bool {
        session.holds(condition)
    }

    func fontAssets() -> [String] {
        session.fontAssets()
    }

    func missingAssets() -> [String] {
        session.missingAssets(available: Set(assets.keys))
    }

    // MARK: Interactions

    func run(_ actions: [OverlayAction]) {
        apply { $0.run(actions) }
    }

    /// Runs a test-hook tap; its events are pushed like a real tap's.
    func simulateTap(identifier: String) -> Result<Void, OverlayTapFailure> {
        var outcome: Result<Void, OverlayTapFailure> = .failure(.notShown)
        apply { session in
            let result = session.simulateTap(identifier: identifier)
            outcome = result.map { _ in () }
            return (try? result.get()) ?? []
        }
        return outcome
    }

    func setPage(_ pager: String, _ target: Int) {
        apply { $0.setPage(pager, target) }
    }

    func toggle(_ key: String, then actions: [OverlayAction]) {
        apply { $0.toggle(key: key, then: actions) }
    }

    func select(index: Int, pager: String?, key: String?, then actions: [OverlayAction] = []) {
        apply { $0.select(index: index, pager: pager, key: key, then: actions) }
    }

    /// A tap on a node's own target or one of its parts; see `OverlaySession.activate`.
    func activate(_ target: OverlayTapTarget) {
        apply { $0.activate(target) ?? [] }
    }

    func choose(key: String, value: String, then actions: [OverlayAction]) {
        apply { $0.choose(key: key, value: value, then: actions) }
    }

    func slide(key: String, value: Double, then actions: [OverlayAction]) {
        apply { $0.slide(key: key, value: value, then: actions) }
    }

    func setTime(hourKey: String, minuteKey: String, hour: Int, minute: Int, then actions: [OverlayAction]) {
        apply { $0.setTime(hourKey: hourKey, minuteKey: minuteKey, hour: hour, minute: minute, then: actions) }
    }

    /// The dialog scrim: closes the dialog without running any button's actions.
    func closeModal(_ node: OverlayNode) {
        apply { $0.closeModal(node) }
    }

    func endEditing() {
        onEndEditing?()
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
