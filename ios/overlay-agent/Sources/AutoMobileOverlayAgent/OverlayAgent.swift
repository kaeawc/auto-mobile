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
    private var sceneObserver: NSObjectProtocol?
    /// App windows' own `accessibilityElementsHidden` while a fullscreen overlay covers them.
    private var hiddenBeforeCovering: [ObjectIdentifier: Bool] = [:]

    private var testHooksEnabled = false

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
        model.onVisibilityChange = { [weak self] visible in self?.setVisible(visible) }
        model.onEndEditing = { [weak self] in _ = self?.window?.endEditing(true) }
        server.start()
        self.server = server
    }

    // MARK: Window

    private func activeScene() -> UIWindowScene? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        return scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
    }

    private func setVisible(_ visible: Bool) {
        if visible {
            attachWindow()
            window?.isHidden = false
        } else {
            window?.isHidden = true
        }
        updateAppAccessibility()
    }

    /// A fullscreen overlay covers the app, so the app's windows leave the accessibility tree:
    /// observe then lists only overlay nodes, and the app's own toolbars cannot be mistaken for
    /// chrome above the overlay. Floating and sheet overlays leave the app reachable.
    func updateAppAccessibility() {
        let covering = model.spec?.window.placement.type == "fullscreen" && window?.isHidden == false
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
        UIAccessibility.post(notification: .screenChanged, argument: nil)
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
        let host = UIHostingController(rootView: OverlayRootView(model: model))
        host.view.backgroundColor = .clear
        window.rootViewController = host
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
                    return result(false, "\(path): Element anchors must be resolved to bounds by the host; update the AutoMobile host")
                }
                model.show(spec, reset: message["reset"] as? Bool == true)
                warnAboutFontAssets(for: spec)
                result(true, extra: missingAssetsExtra())
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
                result(true, extra: ["status": model.status()])
            default:
                result(false, "Unknown request type \(type)")
            }
        } catch {
            result(false, "Invalid overlay spec: \(error)")
        }
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

/// Lays out the shown spec by placement and records the touchable rects for the window.
struct OverlayRootView: View {
    @ObservedObject var model: OverlayModel
    @Environment(\.colorScheme) private var systemScheme

    var body: some View {
        let palette = OverlayPalette.make(theme: model.spec?.theme, systemDark: systemScheme == .dark)
        ZStack {
            if let spec = model.spec {
                let chrome = OverlayHostChrome(placementType: spec.window.placement.type)
                if chrome.reservesDismissBar {
                    // Like Android's fullscreen window: the bar takes the top of the screen and the
                    // spec and its dialogs are laid out and clipped below it, so the control never
                    // covers authored content and a dialog scrim never covers the control.
                    VStack(spacing: 0) {
                        dismissBar(chrome, dark: palette.dark)
                        // The clear base fixes the content area to the space left under the bar;
                        // the spec and the modal layer are laid out in it separately, so a dialog
                        // taller than that area neither pushes the bar up nor moves the spec.
                        Color.clear
                            .overlay { placed(spec).opacity(Double(spec.window.opacity ?? 100) / 100) }
                            .overlay { anchorLayer(spec).opacity(Double(spec.window.opacity ?? 100) / 100) }
                            .overlay {
                                OverlayModalLayer(model: model)
                                    .opacity(Double(spec.window.opacity ?? 100) / 100)
                            }
                            .clipped()
                    }
                } else {
                    placed(spec)
                        .opacity(Double(spec.window.opacity ?? 100) / 100)
                    anchorLayer(spec)
                        .opacity(Double(spec.window.opacity ?? 100) / 100)
                    OverlayModalLayer(model: model)
                        .opacity(Double(spec.window.opacity ?? 100) / 100)
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
        // Bars and cutouts are the spec's job (safeAreaPadding); the keyboard still pushes a
        // sheet or bottom-floating overlay up so its text field stays visible.
        .ignoresSafeArea(.container)
    }

    /// The spec's anchored nodes, above its tree and below its modals, as Android's anchor layer.
    private func anchorLayer(_ spec: OverlaySpec) -> some View {
        OverlayAnchorLayer(entries: spec.root.windowAnchorLayer(state: model.state, pages: model.pages), model: model)
    }

    @ViewBuilder
    private func placed(_ spec: OverlaySpec) -> some View {
        let placement = spec.window.placement
        let root = NodeView(node: spec.root, model: model)
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
                .frame(height: placement.height ?? 200)
                .reportFrame(key: "content", model: model)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: edge)
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
    /// Keeps `model.hitRects[key]` at this view's window frame while it is on screen.
    func reportFrame(key: String, model: OverlayModel) -> some View {
        onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { frame in
            model.hitRects[key] = frame
        }
        .onDisappear { model.hitRects[key] = nil }
    }
}
