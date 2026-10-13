import Observation
import SwiftUI
import UIKit

/// Prototype state owned by the main thread. Transitions and event sequencing live in the
/// device-free `PrototypeSession`; this adds Observation tracking, assets and window geometry.
@MainActor
@Observable
final class PrototypeModel {
    @ObservationIgnored private(set) var session = PrototypeSession()
    private(set) var spec: PrototypeSpec?
    private(set) var state: [String: JSONValue] = [:]
    private(set) var pages: [String: Int] = [:]
    private(set) var appearance: PrototypeAppearance?
    private(set) var deviceDark = false
    /// Redraws controls that hold platform values when a transition leaves state and pages unchanged.
    private var refusedChangeRevision = 0
    /// Receives the new value synchronously before it is stored or any transition side effects run.
    @ObservationIgnored var onSessionChange: ((PrototypeSession) -> Void)?

    private func publish(_ next: PrototypeSession, replacingSpec: Bool = false) {
        onSessionChange?(next)
        // Only show and dismissal change structure; state transitions must not invalidate readers
        // of an unchanged (non-Equatable) spec merely by copying the session back.
        if replacingSpec || session.isShown != next.isShown { spec = next.spec }
        session = next
        if state != next.state { state = next.state }
        if pages != next.pages { pages = next.pages }
        if appearance != next.appearance { appearance = next.appearance }
        if deviceDark != next.deviceDark { deviceDark = next.deviceDark }
    }

    var safeInsets = UIEdgeInsets.zero
    /// The prototype window's own (0, 0) on screen, in points; anchors are screen coordinates.
    var windowOrigin = CGPoint.zero
    /// The prototype window's size in points, for placing a sheet against the keyboard.
    var windowSize = CGSize.zero
    /// The software keyboard's frame in screen points, nil while hidden, and the duration its
    /// show or hide animates over (UIKit keyboard notifications).
    private(set) var keyboardFrame: CGRect?
    @ObservationIgnored private(set) var keyboardDuration: Double?
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
    @ObservationIgnored var hitRects = PrototypeHitRects()

    @ObservationIgnored var onEvent: (([String: Any]) -> Void)?
    @ObservationIgnored var onVisibilityChange: ((Bool) -> Void)?
    /// Resigns keyboard focus inside the prototype window.
    @ObservationIgnored var onEndEditing: (() -> Void)?

    /// Closes snackbars that set `durationMs`; created with the model so it can call back into it.
    @ObservationIgnored private lazy var snackbarTimeouts = SnackbarTimeouts(clock: clock) { [weak self] node in
        // A timer closing a snackbar is not user activity, so it must not restart the idle TTL.
        self?.apply(activity: false) { $0.closeModal(node) }
    }

    /// Ends a prototype nobody has touched for the TTL (`reason: ttl`, as on Android).
    @ObservationIgnored private lazy var idleTimer = PrototypeIdleTimer(clock: clock) { [weak self] in
        self?.dismiss(reason: .ttl)
    }

    @ObservationIgnored private let clock: PrototypeClock

    init(clock: PrototypeClock = SystemPrototypeClock()) {
        self.clock = clock
    }

    /// Local override of the five-minute idle TTL; no wire field carries it. Applies from the next
    /// show or interaction.
    var idleTtlMilliseconds: Int {
        get { idleTimer.ttlMilliseconds }
        set { idleTimer.ttlMilliseconds = newValue }
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

    /// Whether the prototype draws dark: the one value the palette, the host chrome and the window's
    /// UIKit trait all take (`PrototypeSession.appearance`).
    var dark: Bool {
        appearance?.dark ?? deviceDark
    }

    /// Reports the device's appearance. A changed value re-themes a prototype that follows the
    /// device, keeping its state and pages, and pushes `appearance_changed` when its mode changed;
    /// it is not activity.
    func setDeviceDark(_ dark: Bool) {
        guard session.deviceDark != dark else { return }
        apply(activity: false) { $0.setDeviceDark(dark) }
    }

    func show(
        _ spec: PrototypeSpec,
        reset: Bool = false,
        appearance: PrototypeAppearanceOverride = .device,
        specBytes: Int? = nil
    ) {
        // Keep the touchable rects: SwiftUI re-reports a frame only when it changes, so clearing
        // them on a same-geometry re-show would leave the prototype passing every touch through.
        var next = session
        next.show(spec, reset: reset, appearance: appearance, specBytes: specBytes)
        publish(next, replacingSpec: true)
        syncSnackbarTimeouts()
        // An accepted show, including a same-id replace, is activity.
        idleTimer.arm()
        onVisibilityChange?(true)
    }

    /// Uploaded assets are tracked independently of session transitions.
    func putAsset(_ id: String, _ image: UIImage) {
        assets[id] = image
    }

    func removeAsset(_ id: String) {
        guard assets[id] != nil else { return }
        assets[id] = nil
    }

    func holds(_ condition: Condition) -> Bool {
        condition.holds(state)
    }

    func fontAssets() -> [String] {
        _ = spec
        return session.fontAssets()
    }

    func missingAssets() -> [String] {
        _ = spec
        return session.missingAssets(available: Set(assets.keys))
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
            assets = [:]
        }
    }

    /// Runs one session transition, pushes its events, and tears the window down when the
    /// transition ended the prototype. `activity` marks a user interaction, which restarts the idle
    /// TTL while the prototype stays up.
    private func apply(activity: Bool = true, _ transition: (inout PrototypeSession) -> [PrototypeEvent]) {
        let wasShown = session.isShown
        let previous = session
        // `transition` adds the `appearance_changed` a state or page change caused.
        var next = session
        let events = next.transition(transition)
        publish(next)
        // A rejected edit (#11562) or no-op transition leaves the stored values unchanged;
        // redraw value-holding controls so they show those values instead of the refused input.
        if PrototypeRefusedChange.leftValuesUnchanged(before: previous, after: next) { refusedChangeRevision += 1 }
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
            hitRects.removeAll()
            onVisibilityChange?(false)
        }
    }

    func status() -> [String: Any] {
        var status: [String: Any] = [
            "shown": session.isShown,
            "id": spec?.id as Any? ?? NSNull(),
            "pages": pages,
            "state": JSONValue.object(state).foundationObject,
            "assets": assets.keys.sorted(),
            "lastSequence": session.lastSequence,
        ]
        // Only a shown prototype has a resolved mode.
        if let appearance = session.appearance { status["appearance"] = appearance.wireObject }
        return status
    }

    /// Registers a view or binding's dependency on redraws after refused or no-op transitions.
    var refusedChanges: Int {
        refusedChangeRevision
    }

    /// Typing goes through `change`, so every edit both updates state and emits `change`.
    func change(key: String, value: String) {
        apply { $0.change(key: key, value: .string(value)) }
    }
}
