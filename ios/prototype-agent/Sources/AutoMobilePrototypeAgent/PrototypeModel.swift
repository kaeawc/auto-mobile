#if canImport(UIKit)
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
        /// Ends surviving text drafts even when a replacing show leaves their stored value unchanged.
        private(set) var showRevision = 0 { didSet { scrollOffsets = [:] } }
        /// Transient presentation only; never written to or reported as spec state.
        var scrollOffsets: [ObjectIdentifier: Double] = [:]
        func scrollOffset(for target: PrototypeNode) -> Double {
            guard let root = spec?.root, let source = target.scrollLinked?.source else { return 0 }
            func locate(_ node: PrototypeNode, scope: PrototypeNode) -> PrototypeNode? {
                if node === target { return scope }
                if let screens = node.screens {
                    for screen in screens.values {
                        if let found = locate(screen, scope: screen) { return found }
                    }
                }
                if let child = node.child, let found = locate(child, scope: scope) { return found }
                for child in node.children ?? [] {
                    if let found = locate(child, scope: scope) { return found }
                }
                return nil
            }
            let scope = locate(root, scope: root) ?? root
            func find(_ node: PrototypeNode) -> PrototypeNode? {
                if node.type == "scroll", node.id == source { return node }
                if let child = node.child, let found = find(child) { return found }
                for child in node.children ?? [] {
                    if let found = find(child) { return found }
                }
                return nil
            }
            return find(scope).flatMap { scrollOffsets[ObjectIdentifier($0)] } ?? 0
        }

        var expandedSelect: PrototypeNode?
        var menuBounds: [ObjectIdentifier: CGRect] = [:]
        private(set) var state: [String: JSONValue] = [:]
        /// Which swipe-actions row is open; opening one closes the others. Presentation only.
        private(set) var swipe = PrototypeSwipeCoordinator()
        private(set) var shownErrors: Set<String> = []
        private(set) var pages: [String: Int] = [:]
        struct StackDrag {
            let target: String
            let revision: Int
            var progress = 0.0
            var settling = false
        }

        var stackDrag: StackDrag?
        var completedStackSwipe: String?
        private(set) var stackChanges: [String: PrototypeStackChange] = [:]
        private(set) var stackEntries: [String: [PrototypeStackEntry]] = [:]
        private(set) var stacks: [String: PrototypeStackSnapshot] = [:]
        private(set) var appearance: PrototypeAppearance?
        private(set) var deviceDark = false
        private(set) var escapeRevealed = false
        /// VoiceOver and Switch Control need a dismiss button without the two-finger hold.
        var assistiveEscapeVisible = false
        /// Redraws controls that hold platform values when a transition leaves state and pages unchanged.
        private var refusedChangeRevision = 0
        /// Receives the new value synchronously before it is stored or any transition side effects run.
        @ObservationIgnored var onSessionChange: ((PrototypeSession) -> Void)?

        private func publish(_ next: PrototypeSession, replacingSpec: Bool = false) {
            onSessionChange?(next)
            // Only show, dismissal and a device data write (#12519, which rebuilds the drawn tree)
            // change structure; state transitions must not invalidate readers of an unchanged
            // (non-Equatable) spec merely by copying the session back.
            if replacingSpec || session.isShown != next.isShown || session.structureRevision != next.structureRevision {
                spec = next.spec
            }
            session = next
            if let selected = expandedSelect {
                let root = next.spec?.root
                let blocker = root?.openModals(state: next.state, pages: next.pages)
                    .last { ["dialog", "menu"].contains($0.type) }
                if root?.visibleSelect(selected, state: next.state, pages: next.pages) != true ||
                    (blocker != nil && blocker?.visibleSelect(selected, state: next.state, pages: next.pages) != true)
                {
                    expandedSelect = nil
                }
            }
            escapeReveal.sync(hasEscape: hasEscape, shown: next.isShown)
            if state != next.state { state = next.state }
            if shownErrors != next.shownErrors { shownErrors = next.shownErrors }
            if pages != next.pages { pages = next.pages }
            if let drag = stackDrag, next.stackChanges[drag.target]?.revision != drag.revision { stackDrag = nil }
            if stackChanges != next.stackChanges { stackChanges = next.stackChanges }
            if stackEntries != next.stackEntries { stackEntries = next.stackEntries }
            if stacks != next.stacks { stacks = next.stacks }
            if appearance != next.appearance { appearance = next.appearance }
            if deviceDark != next.deviceDark { deviceDark = next.deviceDark }
            // After the model holds the new session: a changed stored key schedules the debounced write,
            // and a dismissal flushes it.
            storage?.sessionChanged(next)
        }

        /// Writes any pending stored values now, for the app leaving the foreground or ending.
        func flushStorage() {
            storage?.flush()
        }

        /// `clear_prototype_storage`: the number of stored keys removed for `id`.
        func clearStorage(id: String) throws -> Int {
            try storage?.clear(id: id) ?? 0
        }

        var safeInsets = UIEdgeInsets.zero
        /// The prototype window's own (0, 0) on screen, in points; anchors are screen coordinates.
        var windowOrigin = CGPoint.zero
        /// The prototype window's size in points, for placing a sheet against the keyboard.
        var windowSize = CGSize.zero
        /// Embedded content may occupy only part of the window; nil preserves window-hosted behavior.
        var keyboardContainerFrame: CGRect?
        /// The software keyboard's frame in screen points, nil while hidden, and the duration its
        /// show or hide animates over (UIKit keyboard notifications).
        private(set) var keyboardFrame: CGRect?
        @ObservationIgnored private(set) var keyboardDuration: Double?
        var assets: [String: UIImage] = [:]
        var fontFaces: [String: String] = [:]
        var assetProblems: [PrototypeSavedProblem] = []

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
                windowOriginY: keyboardContainerFrame.map { Double($0.minY) } ?? Double(windowOrigin.y),
                windowHeight: keyboardContainerFrame.map { Double($0.height) } ?? Double(windowSize.height)
            )
        }

        /// Window-space rects that accept touches; everything else passes through to the app.
        @ObservationIgnored var hitRects = PrototypeHitRects()

        @ObservationIgnored var onEvent: (([String: Any]) -> Void)?
        @ObservationIgnored var onEmbeddedEvent: (@MainActor (PrototypeEvent) -> Void)?
        /// Runs the `request` actions the session starts and cancels (#12529).
        @ObservationIgnored var requestDriver: PrototypeRequestDriver?
        @ObservationIgnored var onVisibilityChange: ((Bool) -> Void)?
        /// Resigns keyboard focus inside the prototype window.
        @ObservationIgnored var onEndEditing: (() -> Void)?

        /// Closes snackbars that set `durationMs`; created with the model so it can call back into it.
        @ObservationIgnored private lazy var snackbarTimeouts = SnackbarTimeouts(clock: clock) { [weak self] node in
            // A timer closing a snackbar is not user activity, so it must not restart the idle TTL.
            self?.apply(activity: false) { $0.closeModal(node) }
        }

        /// Authored timers are non-activity transitions, shared by every host.
        @ObservationIgnored private lazy var timers = PrototypeTimers(clock: clock) { [weak self] actions in
            self?.apply(activity: false) { $0.run(actions) }
        }

        @ObservationIgnored private lazy var deviceState =
            PrototypeDeviceStateStore(clock: clock) { [weak self] name, data in
                self?.apply(activity: false) { session in
                    do { return try session.deliverPlatformEvent(name, data: data) }
                    catch { NSLog("Prototype platform event failed: %@", String(describing: error)); return [] }
                }
            }

        @ObservationIgnored private var lastDeviceState: PrototypeDeviceState?
        @ObservationIgnored var syncDeviceState: (() -> Void)?

        func updateDeviceState(_ state: PrototypeDeviceState) {
            lastDeviceState = state
            guard deviceState.update(state) else { return }
            apply(activity: false) { session in
                do { try session.setPlatformState(deviceState.snapshot) }
                catch { NSLog("Prototype platform state failed: %@", String(describing: error)) }
                return []
            }
        }

        func pauseTimers() { timers.pause() }
        func resumeTimers() { timers.resume() }

        func advanceClock(id: String, milliseconds: Int) -> PrototypeTimers.AdvanceResult {
            guard session.isShown, spec?.id == id else {
                return .init(fired: 0, error: "Unknown prototype id: \(id)")
            }
            return timers.advance(milliseconds)
        }

        /// Ends a prototype nobody has touched for the TTL (`reason: ttl`, as on Android).
        @ObservationIgnored private lazy var idleTimer = PrototypeIdleTimer(clock: clock) { [weak self] in
            self?.dismiss(reason: .ttl)
        }

        /// A reveal is not idle-TTL activity; the injected clock only controls pill visibility.
        @ObservationIgnored private lazy var escapeReveal = PrototypeEscapeReveal(clock: clock) { [weak self] visible in
            self?.escapeRevealed = visible
        }

        var hasEscape: Bool {
            guard let spec else { return false }
            return PrototypeHostChrome(placementType: spec.window.placement.type, chrome: spec.window.chrome).escape
        }

        func revealEscape() {
            escapeReveal.reveal()
        }

        @ObservationIgnored private let clock: PrototypeClock

        /// Stored values (#12526): restored by `show`, written back after changes and on dismissal. Nil
        /// keeps nothing, which is what tests and a sandbox without Application Support get.
        @ObservationIgnored private let storage: PrototypeStorageCoordinator?

        @ObservationIgnored private var timerLifecycle: PrototypeTimerLifecycle?

        let mode: PrototypeLifecycleMode

        init(
            clock: PrototypeClock = SystemPrototypeClock(),
            mode: PrototypeLifecycleMode = .session,
            storage: PrototypeStorageCoordinator? = nil
        ) {
            self.clock = clock
            self.mode = mode
            self.storage = storage
            timerLifecycle = PrototypeTimerLifecycle(model: self)
        }

        /// Local override of the five-minute idle TTL; no wire field carries it. Applies from the next
        /// show or interaction.
        var idleTtlMilliseconds: Int {
            get { idleTimer.ttlMilliseconds }
            set { idleTimer.ttlMilliseconds = newValue }
        }

        /// Re-arms snackbar timeouts against the snackbars the session now has open.
        private func syncSnackbarTimeouts() {
            let open = session.spec?.root
                .openModals(state: session.state, pages: session.pages, stacks: session.stacks) ?? []
            snackbarTimeouts.sync(openModals: open)
        }

        /// The real safe-area insets, except an explicit dismiss bar already clears the top inset.
        var contentSafeInsets: UIEdgeInsets {
            var insets = safeInsets
            let chrome = PrototypeHostChrome(
                placementType: spec?.window.placement.type ?? "fullscreen", chrome: spec?.window.chrome
            )
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
            syncDeviceState?()
            var next = session
            // Stored values replace the spec's for the keys it lists before the first draw, and emit
            // nothing (#12526); the session only receives the result.
            let prepared = storage?.prepare(spec)
            let seeded: PrototypeSpec
            do { seeded = try (prepared?.spec ?? spec).replacingPlatform(deviceState.snapshot) }
            catch { NSLog("Prototype platform seed failed: %@", String(describing: error)); return }
            next.show(
                seeded, reset: reset, appearance: appearance, specBytes: specBytes,
                restoredState: prepared?.state
            )
            // A show that replaces another prototype cancels that one's requests.
            let requestCommands = next.takeRequestCommands()
            let timerCommands = next.takeTimerCommands()
            publish(next, replacingSpec: true)
            deviceState.reset()
            if let lastDeviceState { updateDeviceState(lastDeviceState) }
            timers.perform(timerCommands)
            requestDriver?.perform(requestCommands)
            expandedSelect = nil
            showRevision += 1
            syncSnackbarTimeouts()
            // An accepted show, including a same-id replace, is activity.
            if mode.expiresWhenIdle { idleTimer.arm() }
            onVisibilityChange?(true)
        }

        /// `patch_prototype` (#11675): the session edits the shown prototype in place and its `change` event is
        /// pushed like any state write. A patch is an agent action, not user activity, so the idle TTL is
        /// not restarted; a refused one leaves the session as it was.
        func patch(id: String, baseRevision: Int?, ops: JSONValue) -> PrototypePatchOutcome {
            var outcome = PrototypePatchOutcome.rejected(message: "Unknown prototype id: \(id)", revision: nil)
            apply(activity: false) { session in
                let (result, events) = session.patch(id: id, baseRevision: baseRevision, ops: ops)
                outcome = result
                return events
            }
            return outcome
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

        /// Reading stacks registers the SwiftUI dependency; the pop policy itself stays in core.
        var stackPopTarget: String? {
            _ = spec
            _ = state
            _ = pages
            _ = stacks
            return session.stackPopTarget
        }

        func stackTransition(_ id: String) -> PrototypeStackTransition {
            _ = spec
            return session.stackTransition(id)
        }

        @discardableResult
        func popTopmostStack() -> Bool {
            guard stackPopTarget != nil else { return false }
            apply { $0.popTopmostStack() }
            return true
        }

        func isEnabled(_ node: PrototypeNode) -> Bool {
            node.enabledWhen?.holds(state) ?? true
        }

        func shownError(_ node: PrototypeNode) -> String? {
            // Read the observed fields; the session itself is observation-ignored.
            for key in node.checkedKeys where shownErrors.contains(key) {
                let result = PrototypeChecks.evaluate(state[key], checks: node.checks ?? [], nodeType: node.type)
                if let message = result.firstFailingMessage { return message }
            }
            return nil
        }

        func blur(_ node: PrototypeNode) {
            apply(activity: false) { session in
                session.blur(node)
                return []
            }
        }

        func swipeOpened(_ node: PrototypeNode, side: PrototypeSwipe.Side) {
            _ = swipe.opened(ObjectIdentifier(node), side: side)
        }

        func swipeClosed(_ node: PrototypeNode) {
            swipe.closed(ObjectIdentifier(node))
        }

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
            if session.isShown, session.pages[pager] != before, mode.expiresWhenIdle { idleTimer.arm() }
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

        func dismiss(reason: PrototypeSessionDismissReason) {
            apply(activity: false) { $0.dismiss(reason: reason) }
        }

        /// The last host connection is gone: the prototype ends with `reason: disconnect` and its
        /// uploaded assets are dropped, shown or not (Android's `onClientCountChanged(0)`).
        func hostDisconnected() {
            guard mode.endsWithHost else { return }
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
            let requestCommands = next.takeRequestCommands()
            let timerCommands = next.takeTimerCommands()
            publish(next)
            // A rejected edit (#11562) or no-op transition leaves the stored values unchanged;
            // redraw value-holding controls so they show those values instead of the refused input.
            if PrototypeRefusedChange.leftValuesUnchanged(before: previous, after: next) { refusedChangeRevision += 1 }
            if session.isShown {
                if activity, mode.expiresWhenIdle { idleTimer.arm() }
            } else {
                idleTimer.cancel()
            }
            syncSnackbarTimeouts()
            let timestamp = Int(Date().timeIntervalSince1970 * 1000)
            for var event in events {
                event.wireTimestamp = timestamp
                onEmbeddedEvent?(event)
                onEvent?(event.wireObject(timestamp: timestamp))
            }
            if wasShown, !session.isShown {
                hitRects.removeAll()
                onVisibilityChange?(false)
            }
            timers.perform(timerCommands)
            requestDriver?.perform(requestCommands)
        }

        /// A request's answer. Not user activity: it neither restarts the idle TTL nor needs the
        /// prototype to still be the one that asked (the session drops answers it no longer awaits).
        func completeRequest(_ requestId: String, _ response: PrototypeRequestResponse) {
            apply(activity: false) { $0.completeRequest(requestId, response) }
        }

        func status() -> [String: Any] {
            var status: [String: Any] = [
                "shown": session.isShown,
                "id": spec?.id as Any? ?? NSNull(),
                "pages": pages,
                "stacks": stacks.mapValues(\.wireObject),
                "state": JSONValue.object(state).foundationObject,
                "assets": assets.keys.sorted(),
                "lastSequence": session.lastSequence,
            ]
            let timerSnapshots = timers.snapshot()
            if !timerSnapshots.isEmpty { status["timers"] = timerSnapshots.map(\.wireObject) }
            if !fontFaces.isEmpty { status["fonts"] = fontFaces.keys.sorted() }
            if !assetProblems.isEmpty { status["assetProblems"] = assetProblems.map(\.wireObject) }
            if let data = session.data { status["data"] = JSONValue.object(data).foundationObject }
            if let id = spec?.id, let storage {
                storage.flush()
                if let report = storage.report(id: id) { status["storage"] = report.wireObject }
            }
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

    /// Selector registrations are weakly held by NotificationCenter.
    @MainActor
    private final class PrototypeTimerLifecycle: NSObject {
        private weak var model: PrototypeModel?

        init(model: PrototypeModel) {
            self.model = model
            super.init()
            let center = NotificationCenter.default
            center.addObserver(
                self,
                selector: #selector(pause),
                name: UIApplication.willResignActiveNotification,
                object: nil
            )
            center.addObserver(
                self,
                selector: #selector(resume),
                name: UIApplication.didBecomeActiveNotification,
                object: nil
            )
            if UIApplication.shared.applicationState != .active { model.pauseTimers() }
        }

        deinit { NotificationCenter.default.removeObserver(self) }
        @objc
        private func pause() { model?.pauseTimers() }
        @objc
        private func resume() { model?.resumeTimers() }
    }
#endif
