import Combine
import os
import SwiftUI
import UIKit

private let overlayLog = Logger(subsystem: "dev.jasonpearson.automobile.overlay-agent", category: "overlay")

/// Entry point called from the dyld constructor in Loader.c. The constructor runs before
/// UIApplication exists, so everything waits for the main run loop.
@_cdecl("am_overlay_agent_start")
public func amOverlayAgentStart() {
    DispatchQueue.main.async {
        OverlayAgent.shared.boot()
    }
}

/// A window above the app's own windows (including its alerts) that accepts touches only inside
/// the overlay content and the host dismiss control; everything else falls through to the app.
final class PassthroughWindow: UIWindow {
    weak var model: OverlayModel?

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        guard let model, model.spec != nil,
              model.hitRects.values.contains(where: { $0.contains(point) }) else { return nil }
        return super.hitTest(point, with: event)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        if model?.safeInsets != safeAreaInsets {
            model?.safeInsets = safeAreaInsets
        }
        let origin = screenOrigin
        if model?.windowOrigin != origin {
            model?.windowOrigin = origin
        }
        if model?.windowSize != bounds.size {
            model?.windowSize = bounds.size
        }
    }

    /// Where this window's own (0, 0) is on screen, in points: anchors are screen coordinates.
    var screenOrigin: CGPoint {
        convert(CGPoint.zero, to: screen.coordinateSpace)
    }
}

final class OverlayAgent {
    static let shared = OverlayAgent()

    let model = OverlayModel()
    private var window: PassthroughWindow?
    private var server: OverlayServer?
    private var layers: OverlayLayersViewController?
    private var sceneObserver: NSObjectProtocol?
    private var keyboardObservers: [NSObjectProtocol] = []
    private var sessionObserver: AnyCancellable?
    /// App windows' own `accessibilityElementsHidden` while the overlay covers them.
    private var hiddenBeforeCovering: [ObjectIdentifier: Bool] = [:]
    /// The flags last applied, so an unrelated state change posts no accessibility notification.
    private var appliedAccessibility = OverlayHostAccessibility.hidden

    private var testHooksEnabled = false
    /// Authenticated host connections, as last reported by the server on the main queue.
    private var connectedClients = 0
    /// Hide-for-screenshot hold (#9305); the overlay window stays hidden while it is active.
    private var captureHold = OverlayCaptureHold(now: { ProcessInfo.processInfo.systemUptime })

    func boot() {
        let configuration: OverlayAgentConfiguration
        switch OverlayAgentConfiguration.from(environment: ProcessInfo.processInfo.environment) {
        case let .success(parsed):
            configuration = parsed
        case let .failure(failure):
            // Without a host-allocated port and token there is no safe way to listen.
            NSLog("[AutoMobileOverlayAgent] not starting: %@", failure.description)
            return
        }
        testHooksEnabled = OverlayTestHooks.isEnabled(environment: ProcessInfo.processInfo.environment)
        NSLog(
            "[AutoMobileOverlayAgent] %@ (protocol %d) loaded into %@, listening on 127.0.0.1:%d",
            OverlayAgentProtocol.agentVersion,
            OverlayAgentProtocol.protocolVersion,
            Bundle.main.bundleIdentifier ?? "?",
            configuration.port
        )
        let server = OverlayServer(
            configuration: configuration,
            capabilities: OverlayTestHooks.capabilities(enabled: testHooksEnabled)
        ) { [weak self] message, reply in
            self?.handle(message, reply: reply)
        }
        model.onEvent = { [weak server] event in server?.broadcast(event) }
        server.onClientCountChanged = { [weak self] count in self?.clientCountChanged(count) }
        model.onVisibilityChange = { [weak self] visible in self?.setVisible(visible) }
        model.onEndEditing = { [weak self] in _ = self?.window?.endEditing(true) }
        // `$session` publishes the new value before `model.session` holds it, so the flags are
        // computed from the published value: a dialog opening or closing re-applies them.
        sessionObserver = model.$session.sink { [weak self] session in
            self?.updateAccessibility(session: session)
        }
        observeKeyboard()
        server.start()
        self.server = server
    }

    // MARK: Keyboard

    /// Tracks the app's software keyboard so a bottom sheet can sit above it. The agent runs in the
    /// app's process, so these are the notifications of the keyboard the app shows.
    private func observeKeyboard() {
        let center = NotificationCenter.default
        keyboardObservers = [
            center.addObserver(
                forName: UIResponder.keyboardWillChangeFrameNotification, object: nil, queue: .main
            ) { [weak self] note in
                let info = note.userInfo
                let frame = (info?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue
                let duration = (info?[UIResponder.keyboardAnimationDurationUserInfoKey] as? NSNumber)?.doubleValue
                MainActor.assumeIsolated { self?.model.setKeyboard(frame: frame, duration: duration) }
            },
            center.addObserver(
                forName: UIResponder.keyboardWillHideNotification, object: nil, queue: .main
            ) { [weak self] note in
                let duration = (note.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? NSNumber)?
                    .doubleValue
                MainActor.assumeIsolated { self?.model.setKeyboard(frame: nil, duration: duration) }
            },
        ]
    }

    // MARK: Window

    private func activeScene() -> UIWindowScene? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        return scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
    }

    private func setVisible(_ visible: Bool) {
        if visible {
            attachWindow()
            window?.isHidden = captureHold.isHiding
        } else {
            window?.isHidden = true
        }
        // Every show re-applies, so an app window opened since the last one is covered too.
        updateAccessibility(session: model.session, force: true)
    }

    /// Applies `OverlayHostAccessibility` for `session`. A fullscreen overlay, or an open dialog's
    /// scrim, covers the app, so the app's windows leave the accessibility tree: observe then lists
    /// only overlay nodes, and the app's own toolbars cannot be mistaken for chrome above the
    /// overlay. An open dialog also hides the overlay's own page (#10899) with the UIKit flags the
    /// XCUITest snapshot honours; SwiftUI's `accessibilityHidden` inside one hosting view is not.
    private func updateAccessibility(session: OverlaySession, force: Bool = false) {
        let flags = OverlayHostAccessibility(session: session, windowShown: window?.isHidden == false)
        guard force || flags != appliedAccessibility else { return }
        appliedAccessibility = flags
        layers?.apply(flags)
        updateAppAccessibility(covering: flags.coversApp)
        UIAccessibility.post(notification: .screenChanged, argument: nil)
    }

    private func updateAppAccessibility(covering: Bool) {
        let appWindows = (window?.windowScene?.windows ?? []).filter { $0 !== window }
        if covering {
            for appWindow in appWindows {
                // Remember the app's own value once, so uncovering restores rather than exposes.
                let key = ObjectIdentifier(appWindow)
                if hiddenBeforeCovering[key] == nil {
                    hiddenBeforeCovering[key] = appWindow.accessibilityElementsHidden
                }
                appWindow.accessibilityElementsHidden = true
                // A focused app field would keep the keyboard up and take hardware typing.
                appWindow.endEditing(true)
            }
        } else {
            for appWindow in appWindows {
                if let previous = hiddenBeforeCovering[ObjectIdentifier(appWindow)] {
                    appWindow.accessibilityElementsHidden = previous
                }
            }
            hiddenBeforeCovering = [:]
        }
    }

    private func attachWindow() {
        guard window == nil else { return }
        guard let scene = activeScene() else {
            // The app has not connected a scene yet; attach when one activates.
            sceneObserver = NotificationCenter.default.addObserver(
                forName: UIScene.didActivateNotification, object: nil, queue: .main
            ) { [weak self] _ in
                guard let self, self.model.spec != nil else { return }
                if let observer = self.sceneObserver { NotificationCenter.default.removeObserver(observer) }
                self.sceneObserver = nil
                self.setVisible(true)
            }
            return
        }
        let window = PassthroughWindow(windowScene: scene)
        window.model = model
        window.windowLevel = .alert + 1
        let layers = OverlayLayersViewController(model: model)
        window.rootViewController = layers
        self.layers = layers
        window.isHidden = false
        model.safeInsets = window.safeAreaInsets
        model.windowOrigin = window.screenOrigin
        self.window = window
    }

    // MARK: Protocol

    private func handle(_ message: [String: Any], reply: @escaping ([String: Any]) -> Void) {
        let type = message["type"] as? String ?? ""
        let requestId = message["requestId"] as Any? ?? NSNull()
        let started = Date()
        func result(_ success: Bool, _ error: String? = nil, extra: [String: Any] = [:]) {
            var body: [String: Any] = [
                "type": "overlay_result",
                "requestId": requestId,
                "success": success,
                "totalTimeMs": Int(Date().timeIntervalSince(started) * 1000),
            ]
            if let error { body["error"] = error }
            body.merge(extra) { _, new in new }
            reply(body)
        }
        if let rejection = OverlayTestHooks.rejection(requestType: type, enabled: testHooksEnabled) {
            return result(false, rejection)
        }
        do {
            switch type {
            case "simulate_tap":
                guard let identifier = message["nodeId"] as? String else {
                    return result(false, "simulate_tap needs a nodeId")
                }
                switch model.simulateTap(identifier: identifier) {
                case .success: result(true)
                case .failure(.notShown): result(false, "No overlay is shown")
                case .failure(.notFound): result(false, "No node with id or testTag \(identifier)")
                case .failure(.notTappable): result(false, "Node \(identifier) has no onTap")
                }
            case "show_overlay":
                let spec = try decode(OverlaySpec.self, message["spec"])
                // The host resolves element anchors to bounds (#9316); drawing one that it did not
                // would silently misplace the node, so the show is refused and nothing changes.
                if let path = spec.root.unresolvedAnchorPath() {
                    return result(
                        false,
                        "\(path): Element anchors must be resolved to bounds by the host; update the AutoMobile host"
                    )
                }
                model.show(spec, reset: message["reset"] as? Bool == true)
                warnAboutFontAssets(for: spec)
                let missing = missingAssetsExtra()
                // The host can leave before this queued show runs; nothing would remove it later.
                if connectedClients == 0 { model.hostDisconnected() }
                result(true, extra: missing)
            // No update_overlay (#10550): a same-id show_overlay replaces the shown overlay.
            case "dismiss_overlay":
                // Like Android's OverlayController: an id that is not the shown overlay fails, and
                // the dismissal still emits the terminal `dismissed` event that event waiters
                // settle on.
                let all = message["all"] as? Bool == true
                guard all || (model.spec != nil && model.spec?.id == message["id"] as? String) else {
                    return result(false, "Unknown overlay id: \(message["id"] ?? "nil")")
                }
                model.dismiss(reason: .agent)
                result(true)
            case "put_overlay_asset":
                guard let id = message["id"] as? String,
                      let base64 = message["dataBase64"] as? String,
                      let data = Data(base64Encoded: base64),
                      let image = UIImage(data: data)
                else { return result(false, "Asset must carry an id and a base64 PNG, JPEG or WebP image") }
                model.putAsset(id, image)
                result(true)
            case "remove_overlay_asset":
                if let id = message["id"] as? String { model.removeAsset(id) }
                result(true)
            case "get_overlay_status":
                var status = model.status()
                status["visible"] = window?.isHidden == false
                result(true, extra: ["status": status])
            case OverlayAgentProtocol.hideForCaptureRequest:
                hideForCapture(
                    deadlineMs: OverlayCaptureHold
                        .clampedDeadlineMs(message["deadlineMs"])
                ) { hidden, token in
                    result(true, extra: ["hidden": hidden, "token": token])
                }
            case OverlayAgentProtocol.restoreAfterCaptureRequest:
                result(true, extra: ["restored": restoreAfterCapture(token: (message["token"] as? NSNumber)?.intValue)])
            default:
                result(false, "Unknown request type \(type)")
            }
        } catch {
            result(false, "Invalid overlay spec: \(error)")
        }
    }

    // MARK: Host connection

    /// The overlay belongs to the host session: when the last authenticated connection closes it
    /// is dismissed (`reason: disconnect`) and its assets dropped, as on Android.
    private func clientCountChanged(_ count: Int) {
        connectedClients = count
        if count < 1 { model.hostDisconnected() }
    }

    // MARK: Hide for capture

    /// Hides the overlay window and replies once the hide has been committed to the render
    /// server, so the host's screenshot cannot still contain it. The hold restores itself at the
    /// deadline, which is what makes a cancelled host safe.
    /// `committed` gets `hidden` (the overlay is off screen because of this hold: it was visible
    /// and is now hidden, or another live hold already hid it) and this hold's token. `hidden:
    /// false` means nothing was visible, so the capture holds no overlay either.
    private func hideForCapture(deadlineMs: Int, committed: @escaping (Bool, Int) -> Void) {
        let heldByOthers = captureHold.isHiding
        let ticket = captureHold.hide(deadlineMs: deadlineMs)
        let wasVisible = window?.isHidden == false || heldByOthers
        window?.isHidden = true
        CATransaction.flush()
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(deadlineMs)) { [weak self] in
            guard let self, self.captureHold.expire(ticket) else { return }
            self.showAfterCapture()
        }
        FrameWaiter.nextFrame { committed(wasVisible, ticket.token) }
    }

    /// `true` when a live hold was released. The overlay comes back only with the last hold.
    private func restoreAfterCapture(token: Int?) -> Bool {
        let release = captureHold.restore(token: token)
        if release.shouldShow { showAfterCapture() }
        return release.released
    }

    private func showAfterCapture() {
        window?.isHidden = model.spec == nil
        updateAccessibility(session: model.session)
    }

    /// One warning per shown spec: an uploaded font cannot be loaded on iOS, so its text uses the
    /// system font. The ids also come back in `missingAssets`, like any asset the host has not sent.
    private func warnAboutFontAssets(for spec: OverlaySpec) {
        let fonts = model.fontAssets()
        guard !fonts.isEmpty else { return }
        overlayLog.warning(
            "overlay \(spec.id, privacy: .public): fontFamily asset unsupported on iOS, using system font for \(fonts.joined(separator: ","), privacy: .public)"
        )
    }

    private func missingAssetsExtra() -> [String: Any] {
        let missing = model.missingAssets()
        return missing.isEmpty ? [:] : ["missingAssets": missing]
    }

    private func decode<T: Decodable>(_ type: T.Type, _ value: Any?) throws -> T {
        guard let value else { throw NSError(
            domain: "overlay",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "missing field"]
        ) }
        let data = try JSONSerialization.data(withJSONObject: value, options: .fragmentsAllowed)
        return try JSONDecoder().decode(type, from: data)
    }
}

/// The overlay window's root: the page's hosting view with the top layer's above it (see
/// `OverlayHostLayer`). Each lays out the whole window the same way and draws only its own layer,
/// so their `.global` frames, and the hit rects reported from them, are both window coordinates.
final class OverlayLayersViewController: UIViewController {
    private let model: OverlayModel
    private let page: UIHostingController<OverlayRootView>
    private let top: UIHostingController<OverlayRootView>

    init(model: OverlayModel) {
        self.model = model
        page = UIHostingController(rootView: OverlayRootView(model: model, layer: .page))
        top = UIHostingController(rootView: OverlayRootView(model: model, layer: .top))
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func loadView() {
        view = OverlayLayersView(model: model)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        for host in [page, top] {
            // Only `OverlayKeyboardLift` moves anything for the keyboard (#11042), and the window's
            // insets reach the spec through the model, so neither host applies a safe area of its
            // own. This is UIKit's switch: with only the root's `ignoresSafeArea`, a 300 pt sheet
            // still moved 527 pt for a 334 pt lift on an iOS 26.5 simulator.
            host.safeAreaRegions = SafeAreaRegions(OverlayKeyboardLift.hostSafeAreaRegions)
            addChild(host)
            host.view.backgroundColor = .clear
            host.view.frame = view.bounds
            host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            view.addSubview(host.view)
            host.didMove(toParent: self)
        }
        (view as? OverlayLayersView)?.hosts = (page.view, top.view)
    }

    /// Sets the UIKit flags an open dialog needs: the page leaves the accessibility tree and the top
    /// layer is modal, so the XCUITest snapshot lists only the dialog and the host dismiss control.
    func apply(_ flags: OverlayHostAccessibility) {
        loadViewIfNeeded()
        page.view.accessibilityElementsHidden = flags.pageElementsHidden
        top.view.accessibilityViewIsModal = flags.topIsModal
    }
}

/// Routes each touch to the hosting view that drew what is under it. Both views fill the window,
/// so without this the top one would take every touch, including those meant for the page.
private final class OverlayLayersView: UIView {
    weak var model: OverlayModel?
    var hosts: (page: UIView, top: UIView)?

    init(model: OverlayModel) {
        self.model = model
        super.init(frame: .zero)
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        guard let model, let hosts,
              let owner = OverlayHostLayer.owner(of: convert(point, to: nil), hitRects: model.hitRects)
        else { return nil }
        let target = owner == .top ? hosts.top : hosts.page
        return target.hitTest(convert(point, to: target), with: event)
    }
}

/// Lays out the shown spec by placement and records the touchable rects for the window. `layer`
/// picks what this hosting view draws: the page (the spec's tree and anchor layer) or the top
/// layer (open dialogs and snackbars and the host dismiss control).
struct OverlayRootView: View {
    @ObservedObject var model: OverlayModel
    let layer: OverlayHostLayer
    @Environment(\.colorScheme) private var systemScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let palette = OverlayPalette.make(theme: model.spec?.theme, systemDark: systemScheme == .dark)
        // An open dialog makes the page behind it inert for accessibility, as it is for touches
        // (#10899). VoiceOver honours this collapse; the XCUITest snapshot needs the UIKit flags
        // `OverlayLayersViewController.apply` sets on the page's hosting view.
        let pageAccessibility = model.spec?.root.layerAccessibility(state: model.state, pages: model.pages)
            ?? .container
        ZStack {
            if let spec = model.spec {
                let chrome = OverlayHostChrome(placementType: spec.window.placement.type)
                let opacity = Double(spec.window.opacity ?? 100) / 100
                if chrome.reservesDismissBar {
                    // Like Android's fullscreen window: the bar takes the top of the screen and the
                    // spec and its dialogs are laid out and clipped below it, so the control never
                    // covers authored content and a dialog scrim never covers the control. The page
                    // layer keeps the bar's space empty; the top layer draws the bar.
                    VStack(spacing: 0) {
                        if layer == .top {
                            dismissBar(chrome, dark: palette.dark)
                        } else {
                            Color.clear.frame(height: chrome.dismissBarHeight(safeTop: model.safeInsets.top))
                        }
                        // The clear base fixes the content area to the space left under the bar;
                        // the spec and the modal layer are laid out in it separately, so a dialog
                        // taller than that area neither pushes the bar up nor moves the spec.
                        Color.clear
                            .overlay {
                                if layer == .page {
                                    placed(spec, layer: pageAccessibility).opacity(opacity)
                                }
                            }
                            .overlay {
                                if layer == .page {
                                    anchorLayer(spec).opacity(opacity).overlayLayerAccessibility(pageAccessibility)
                                }
                            }
                            .overlay {
                                if layer == .top {
                                    OverlayModalLayer(model: model).opacity(opacity)
                                }
                            }
                            .clipped()
                    }
                } else if layer == .page {
                    placed(spec, layer: pageAccessibility).opacity(opacity)
                    anchorLayer(spec).opacity(opacity).overlayLayerAccessibility(pageAccessibility)
                } else {
                    OverlayModalLayer(model: model).opacity(opacity)
                    dismissControl()
                        .padding(.top, model.safeInsets.top)
                        .padding(.trailing, max(model.safeInsets.right, 8))
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
                }
            }
        }
        // Scheme-aware system controls (text fields, buttons) follow the theme's light or dark.
        .environment(\.colorScheme, palette.dark ? .dark : .light)
        .environment(\.overlayPalette, palette)
        .environment(\.overlayTypography, OverlayTypography(theme: model.spec?.theme?.typography))
        .environment(\.overlayShapes, OverlayShapes(theme: model.spec?.theme?.shapes))
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        // Bars and cutouts are the spec's job (safeAreaPadding). A bottom sheet is raised by the
        // keyboard frame itself (`keyboardLift`) and nothing else moves for the keyboard, as on
        // Android: the hosts keep no safe area (`OverlayKeyboardLift.hostSafeAreaRegions`), and
        // this ignores every region too, so no second lift can stack on the sheet's (#11042).
        .ignoresSafeArea()
    }

    /// The spec's anchored nodes, above its tree and below its modals, as Android's anchor layer.
    private func anchorLayer(_ spec: OverlaySpec) -> some View {
        let placement = spec.window.placement
        let motion = OverlayMotion(specMotion: spec.motion, reduceMotion: reduceMotion)
        return OverlayAnchorLayer(
            entries: spec.root.windowAnchorLayer(
                state: model.state, pages: model.pages, retainExiting: motion.enabled
            ),
            model: model,
            sheet: placement.type == "sheet"
                ? OverlayAnchorLayer.Sheet(edge: placement.edge, height: placement.height, lift: keyboardLift)
                : nil
        )
        .animation(keyboardLiftDuration.map { .easeInOut(duration: $0) }, value: keyboardLift)
    }

    /// How far the bottom sheet is raised and how long the move takes: the keyboard's own duration,
    /// or instant under spec `motion: "none"` or Reduce Motion.
    private var keyboardLift: Double {
        model.keyboardLift
    }

    private var keyboardLiftDuration: Double? {
        OverlayKeyboardLift.animationDuration(
            keyboardDuration: model.keyboardDuration,
            motion: OverlayMotion(specMotion: model.spec?.motion, reduceMotion: reduceMotion)
        )
    }

    @ViewBuilder
    private func placed(_ spec: OverlaySpec, layer: OverlayLayerAccessibility) -> some View {
        let placement = spec.window.placement
        // The boundary sits on the root itself, inside the placement's fill frames, so a lone
        // node keeps its own accessibility frame (#10898).
        let root = NodeView(node: spec.root, model: model).overlayLayerAccessibility(layer)
        // There is no window to move onto an anchored root: the anchor layer places it, and an
        // empty sheet or floating slot must not catch touches meant for the app.
        let rootAnchored = spec.root.anchor != nil
        switch placement.type {
        case "sheet" where rootAnchored, "floating" where rootAnchored:
            EmptyView()
        case "sheet":
            let edge: Alignment = placement.edge == "top" ? .top : .bottom
            root
                .frame(maxWidth: .infinity)
                .frame(height: placement.height ?? OverlaySheetFrame.defaultHeight)
                .reportFrame(key: "content", model: model)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: edge)
                // The sheet's frame is reported from inside, so its touch rect follows the lift.
                .padding(.bottom, keyboardLift)
                .animation(keyboardLiftDuration.map { .easeInOut(duration: $0) }, value: keyboardLift)
        case "floating":
            root
                .offset(x: placement.offset?.x ?? 0, y: placement.offset?.y ?? 0)
                .reportFrame(key: "content", model: model)
                .padding(EdgeInsets(
                    top: model.safeInsets.top, leading: model.safeInsets.left,
                    bottom: model.safeInsets.bottom, trailing: model.safeInsets.right
                ))
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: swiftUIAlignment(placement.gravity))
        default:
            // Fullscreen blocks the app, like the Android full-screen window.
            ZStack(alignment: .topLeading) {
                Color(hex: placement.scrim) ?? .clear
                root
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .contentShape(Rectangle())
            .reportFrame(key: "content", model: model)
        }
    }

    /// Host-owned control the spec cannot remove (#9307).
    private func dismissControl(glyph: Color = .white, fill: Color = Color.black.opacity(0.55)) -> some View {
        Button {
            model.dismiss(reason: .user)
        } label: {
            Image(systemName: "xmark")
                .font(.system(size: 13, weight: .bold))
                .foregroundColor(glyph)
                .frame(width: 30, height: 30)
                .background(Circle().fill(fill))
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .accessibilityIdentifier("automobile-overlay-dismiss")
        .accessibilityLabel("Dismiss overlay")
        .reportFrame(key: "dismiss", model: model)
    }

    /// The fullscreen dismiss bar: it clears the status bar and cutout, holds only the control, and
    /// is translucent and themed like the spec (Android's `overlayDismissColors`, #10522). Its rect
    /// is a hit rect, so a tap on the bar beside the control still never reaches the covered app.
    private func dismissBar(_ chrome: OverlayHostChrome, dark: Bool) -> some View {
        let colors = OverlayHostChrome.dismissBarColors(dark: dark)
        let content = Color(colors.content)
        return dismissControl(glyph: content, fill: content.opacity(0.12))
            .padding(.top, model.safeInsets.top)
            .padding(.leading, model.safeInsets.left)
            .padding(.trailing, max(model.safeInsets.right, 8))
            .frame(maxWidth: .infinity, alignment: .trailing)
            .frame(height: chrome.dismissBarHeight(safeTop: model.safeInsets.top), alignment: .bottom)
            .background(Color(colors.background))
            .reportFrame(key: "dismissBar", model: model)
    }
}

extension View {
    /// Applies a layer's accessibility shape. The child behaviour is a value rather than a
    /// branch, so the layer keeps its view identity (and scroll positions) when a dialog opens.
    func overlayLayerAccessibility(_ layer: OverlayLayerAccessibility) -> some View {
        accessibilityElement(children: layer == .collapsed ? .ignore : .contain)
            .accessibilityHidden(layer == .collapsed)
    }

    /// Keeps `model.hitRects[key]` at this view's window frame while it is on screen.
    /// With `clip`, only the part of the frame inside it takes touches; `enabled: false` withdraws
    /// the rect while the view stays on screen (an anchored node fading out with its ancestor).
    func reportFrame(key: String, model: OverlayModel, clip: CGRect? = nil, enabled: Bool = true) -> some View {
        onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { frame in
            let touchable = clip.map { frame.intersection($0) } ?? frame
            model.hitRects[key] = enabled && !touchable.isNull && !touchable.isEmpty ? touchable : nil
        }
        .onChange(of: enabled) { _, now in
            if !now { model.hitRects[key] = nil }
        }
        .onDisappear { model.hitRects[key] = nil }
    }
}

/// Calls back after the next display frame, so a visual change made just before is on screen.
/// Falls back after 100 ms if no frame is delivered (backgrounded app, paused display link).
private final class FrameWaiter: NSObject {
    private var link: CADisplayLink?
    private var completion: (() -> Void)?

    static func nextFrame(_ completion: @escaping () -> Void) {
        let waiter = FrameWaiter()
        waiter.completion = completion
        let link = CADisplayLink(target: waiter, selector: #selector(tick))
        link.add(to: .main, forMode: .common)
        waiter.link = link
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(100)) { waiter.finish() }
    }

    @objc
    private func tick() {
        finish()
    }

    private func finish() {
        link?.invalidate()
        link = nil
        let done = completion
        completion = nil
        done?()
    }
}

extension SafeAreaRegions {
    /// The UIKit regions for the agent's device-free `OverlayHostSafeAreaRegions`.
    init(_ regions: OverlayHostSafeAreaRegions) {
        self = []
        if regions.contains(.container) { insert(.container) }
        if regions.contains(.keyboard) { insert(.keyboard) }
    }
}
