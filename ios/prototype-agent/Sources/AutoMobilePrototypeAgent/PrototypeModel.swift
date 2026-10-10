import Combine
import SwiftUI
import UIKit

/// Prototype state owned by the main thread. Transitions and event sequencing live in the
/// device-free `PrototypeSession`; this adds SwiftUI publishing, assets and window geometry.
final class PrototypeModel: ObservableObject {
    @Published private(set) var session = PrototypeSession()
    @Published var safeInsets = UIEdgeInsets.zero
    /// The prototype window's own (0, 0) on screen, in points; anchors are screen coordinates.
    @Published var windowOrigin = CGPoint.zero
    /// The prototype window's size in points, for placing a sheet against the keyboard.
    @Published var windowSize = CGSize.zero
    /// The software keyboard's frame in screen points, nil while hidden, and the duration its
    /// show or hide animates over (UIKit keyboard notifications).
    @Published private(set) var keyboardFrame: CGRect?
    private(set) var keyboardDuration: Double?
    var assets: [String: UIImage] = [:]

    func setKeyboard(frame: CGRect?, duration: Double?) {
        keyboardDuration = duration
        keyboardFrame = frame
    }

    /// Points a bottom sheet is raised above the keyboard; 0 for every other placement.
    var keyboardLift: Double {
        let placement = spec?.window.placement
        return PrototypeKeyboardLift.amount(
            placementType: placement?.type ?? "",
            edge: placement?.edge,
            keyboardFrame: keyboardFrame.map {
                PrototypeRect(x: $0.minX, y: $0.minY, width: $0.width, height: $0.height)
            },
            windowOriginY: windowOrigin.y,
            windowHeight: windowSize.height
        )
    }

    /// Window-space rects that accept touches; everything else passes through to the app.
    var hitRects: [String: CGRect] = [:]

    var onEvent: (([String: Any]) -> Void)?
    var onVisibilityChange: ((Bool) -> Void)?
    /// Resigns keyboard focus inside the prototype window.
    var onEndEditing: (() -> Void)?

    /// Closes snackbars that set `durationMs`; created with the model so it can call back into it.
    private lazy var snackbarTimeouts = SnackbarTimeouts(clock: clock) { [weak self] node in
        // A timer closing a snackbar is not user activity, so it must not restart the idle TTL.
        self?.apply(activity: false) { $0.closeModal(node) }
    }

    /// Ends a prototype nobody has touched for the TTL (`reason: ttl`, as on Android).
    private lazy var idleTimer = PrototypeIdleTimer(clock: clock) { [weak self] in
        self?.dismiss(reason: .ttl)
    }

    private let clock: PrototypeClock

    init(clock: PrototypeClock = SystemPrototypeClock()) {
        self.clock = clock
    }

    /// Local override of the five-minute idle TTL; no wire field carries it. Applies from the next
    /// show or interaction.
    var idleTtlMilliseconds: Int {
        get { idleTimer.ttlMilliseconds }
        set { idleTimer.ttlMilliseconds = newValue }
    }

    var spec: PrototypeSpec? {
        session.spec
    }

    /// Re-arms snackbar timeouts against the snackbars the session now has open.
    private func syncSnackbarTimeouts() {
        let open = session.spec?.root.openModals(state: session.state, pages: session.pages) ?? []
        snackbarTimeouts.sync(openModals: open)
    }

    /// The safe-area insets `safeAreaPadding` sees inside the spec: a fullscreen spec sits below the
    /// host dismiss bar, which already clears the top inset.
    var contentSafeInsets: UIEdgeInsets {
        var insets = safeInsets
        let chrome = PrototypeHostChrome(placementType: spec?.window.placement.type ?? "fullscreen")
        insets.top = chrome.contentSafeTop(safeTop: insets.top)
        return insets
    }

    var state: [String: JSONValue] {
        session.state
    }

    var pages: [String: Int] {
        session.pages
    }

    func show(_ spec: PrototypeSpec, reset: Bool = false) {
        // Keep the touchable rects: SwiftUI re-reports a frame only when it changes, so clearing
        // them on a same-geometry re-show would leave the prototype passing every touch through.
        session.show(spec, reset: reset)
        syncSnackbarTimeouts()
        // An accepted show, including a same-id replace, is activity.
        idleTimer.arm()
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

    func run(_ actions: [PrototypeAction]) {
        apply { $0.run(actions) }
    }

    /// Runs a test-hook tap; its events are pushed like a real tap's.
    func simulateTap(identifier: String) -> Result<Void, PrototypeTapFailure> {
        var outcome: Result<Void, PrototypeTapFailure> = .failure(.notShown)
        apply { session in
            let result = session.simulateTap(identifier: identifier)
            outcome = result.map { _ in () }
            return (try? result.get()) ?? []
        }
        return outcome
    }

    func setPage(_ pager: String, _ target: Int) {
        // SwiftUI reports the settled page on appear; only a page that changed is activity.
        let before = session.pages[pager]
        apply(activity: false) { $0.setPage(pager, target) }
        if session.isShown, session.pages[pager] != before { idleTimer.arm() }
    }

    func toggle(_ key: String, then actions: [PrototypeAction]) {
        apply { $0.toggle(key: key, then: actions) }
    }

    func select(index: Int, pager: String?, key: String?, then actions: [PrototypeAction] = []) {
        apply { $0.select(index: index, pager: pager, key: key, then: actions) }
    }

    /// A tap on a node's own target or one of its parts; see `PrototypeSession.activate`.
    func activate(_ target: PrototypeTapTarget) {
        apply { $0.activate(target) ?? [] }
    }

    func choose(key: String, value: String, then actions: [PrototypeAction]) {
        apply { $0.choose(key: key, value: value, then: actions) }
    }

    func slide(key: String, value: Double, then actions: [PrototypeAction]) {
        apply { $0.slide(key: key, value: value, then: actions) }
    }

    func setTime(hourKey: String, minuteKey: String, hour: Int, minute: Int, then actions: [PrototypeAction]) {
        apply { $0.setTime(hourKey: hourKey, minuteKey: minuteKey, hour: hour, minute: minute, then: actions) }
    }

    /// The dialog scrim: closes the dialog without running any button's actions.
    func closeModal(_ node: PrototypeNode) {
        apply { $0.closeModal(node) }
    }

    func endEditing() {
        onEndEditing?()
    }

    func dismiss(reason: PrototypeDismissReason) {
        apply(activity: false) { $0.dismiss(reason: reason) }
    }

    /// The last host connection is gone: the prototype ends with `reason: disconnect` and its
    /// uploaded assets are dropped, shown or not (Android's `onClientCountChanged(0)`).
    func hostDisconnected() {
        dismiss(reason: .disconnect)
        if !assets.isEmpty {
            objectWillChange.send()
            assets = [:]
        }
    }

    /// Runs one session transition, pushes its events, and tears the window down when the
    /// transition ended the prototype. `activity` marks a user interaction, which restarts the idle
    /// TTL while the prototype stays up.
    private func apply(activity: Bool = true, _ transition: (inout PrototypeSession) -> [PrototypeEvent]) {
        let wasShown = session.isShown
        let events = transition(&session)
        if session.isShown {
            if activity { idleTimer.arm() }
        } else {
            idleTimer.cancel()
        }
        syncSnackbarTimeouts()
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
            "lastSequence": session.lastSequence,
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
