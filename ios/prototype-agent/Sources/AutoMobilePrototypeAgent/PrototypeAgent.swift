import os
import SwiftUI
import UIKit

private let prototypeLog = Logger(subsystem: "dev.jasonpearson.automobile.prototype-agent", category: "prototype")

/// Entry point called from the dyld constructor in Loader.c. The constructor runs before
/// UIApplication exists, so everything waits for the main run loop.
@_cdecl("am_prototype_agent_start")
public func amPrototypeAgentStart() {
    DispatchQueue.main.async {
        PrototypeAgent.shared.boot()
    }
}

/// For an app linking the agent directly (the viewer); run instead of, not after, the Loader.c injection constructor.
@_cdecl("am_prototype_agent_start_standalone")
public func amPrototypeAgentStartStandalone() {
    DispatchQueue.main.async {
        PrototypeAgent.bootStandalone()
    }
}

/// A distinct selector target keeps each scene registration's identity and synchronous delivery.
@MainActor
private final class PrototypeSceneActivationObserver: NSObject {
    private let action: (Notification) -> Void

    init(action: @escaping (Notification) -> Void) { self.action = action }

    @objc
    func activated(_ note: Notification) { action(note) }
}

/// A window above the app's own windows (including its alerts) that accepts touches only inside
/// the prototype content and the host dismiss control; everything else falls through to the app.
@MainActor
final class PassthroughWindow: UIWindow {
    weak var model: PrototypeModel?

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        guard let model, model.spec != nil else { return nil }
        if nativePresentationRegion()?.contains(point) == true { return super.hitTest(point, with: event) }
        guard model.hitRects.contains(point) else { return nil }
        return super.hitTest(point, with: event)
    }

    /// The area a native presentation from the root controller claims (#15463), computed at hit
    /// time so it follows detent changes and dismissal without observation. Not yet device-verified.
    private func nativePresentationRegion() -> CGRect? {
        guard let presented = rootViewController?.presentedViewController, !presented.isBeingDismissed else {
            return nil
        }
        var interaction = PrototypeNativePresentationHitRegion.Interaction.modal
        if let sheet = presented.sheetPresentationController {
            let detents = sheet.detents.map(\.identifier)
            interaction = PrototypeNativePresentationHitRegion.interaction(
                selectedDetentIndex: sheet.selectedDetentIdentifier.flatMap(detents.firstIndex(of:)),
                largestUndimmedDetentIndex: sheet.largestUndimmedDetentIdentifier.flatMap(detents.firstIndex(of:))
            )
        }
        return PrototypeNativePresentationHitRegion.region(
            interaction: interaction,
            presentedFrame: presented.presentationController?.frameOfPresentedViewInContainerView
                ?? presented.view.frame,
            windowBounds: bounds
        )
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

@MainActor
final class PrototypeAgent: NSObject {
    private static var instance: PrototypeAgent?
    static var shared: PrototypeAgent {
        if let instance { return instance }
        let agent = PrototypeAgent(mode: .session)
        instance = agent
        return agent
    }

    static func bootStandalone() {
        if let instance {
            NSLog(
                "[AutoMobilePrototypeAgent] standalone requested after the agent already started in %@ mode; ignoring",
                String(describing: instance.model.mode)
            )
            return
        }

        let agent = PrototypeAgent(mode: .standalone)
        instance = agent
        agent.boot()
    }

    static func bootViewerHost(model: PrototypeModel, container: String, savedSpecId: String?, layoutDirectory: URL) {
        guard instance == nil else { return }
        let agent = PrototypeAgent(model: model)
        instance = agent
        agent.viewerHosted = true
        agent.booted = true
        agent.viewerSaveBack = PrototypeViewerSaveBack(savedSpecId: savedSpecId, layoutDirectory: layoutDirectory)
        let publisher = PrototypeEndpointPublisher(root: container)
        agent.viewerEndpoint = publisher
        let server = PrototypeServer(
            configuration: PrototypeAgentConfiguration(port: 0, token: publisher.token),
            capabilities: PrototypeViewerHostCapabilities.advertised(
                model.mode.advertising(PrototypeTestHooks.capabilities(enabled: false))
            ),
            maxAuthenticatedClients: 1,
            onReady: { [weak agent] port in
                do {
                    try publisher.publish(port: port)
                } catch {
                    NSLog(
                        "[AutoMobilePrototypeAgent] could not publish viewer endpoint (error code %ld)",
                        (error as NSError).code
                    )
                    publisher.retract()
                    agent?.server?.close()
                }
            },
            handler: { [weak agent] message, reply in
                agent?.handle(message, reply: reply)
            }
        )
        server.onFailed = { publisher.retract() }
        model.onEvent = { [weak agent, weak server] event in
            guard let agent else { return }
            for pending in agent.outbox.publish(event) {
                server?.broadcast(pending)
            }
        }
        server.onClientCountChanged = { [weak agent] count in agent?.clientCountChanged(count) }
        agent.server = server
        agent.installRequestDriver()
        server.start()
    }

    /// Writes any pending stored prototype values; the viewer calls it as the app terminates.
    static func flushStorage() {
        instance?.model.flushStorage()
    }

    static func retractViewerEndpoint() {
        instance?.viewerEndpoint?.retract()
    }

    let model: PrototypeModel
    private var outbox: PrototypeEventOutbox<[String: Any]>

    init(mode: PrototypeLifecycleMode = .session) {
        model = PrototypeModel(mode: mode, storage: PrototypeStorageCoordinator.fileBacked())
        outbox = PrototypeEventOutbox(mode: mode)
        super.init()
    }

    private init(model: PrototypeModel) {
        self.model = model
        outbox = PrototypeEventOutbox(mode: model.mode)
        super.init()
    }

    private var viewerHosted = false
    private var viewerEndpoint: PrototypeEndpointPublisher?
    private var viewerSaveBack: PrototypeViewerSaveBack?
    private var window: PassthroughWindow?
    private var server: PrototypeServer?
    private var booted = false
    private var layers: PrototypeLayersViewController?
    private var sceneObserver: PrototypeSceneActivationObserver?
    // Selector observers are weakly held by NotificationCenter. Retain each registration just as
    // its old block registration was retained by the center until that registration was removed.
    private var sceneObservers: [PrototypeSceneActivationObserver] = []
    /// Keeps the scene's appearance observation alive; the window, once attached, is never removed.
    private var localeObservation: NSObjectProtocol?
    private let localeProvider: any PrototypeLocaleProvider = SystemPrototypeLocaleProvider()
    private var appearanceObservation: (any UITraitChangeRegistration)?
    /// App windows' own `accessibilityElementsHidden` while the prototype covers them.
    private var hiddenBeforeCovering: [ObjectIdentifier: Bool] = [:]
    /// The flags last applied, so an unrelated state change posts no accessibility notification.
    private var appliedAccessibility = PrototypeHostAccessibility.hidden

    private var testHooksEnabled = false
    /// Authenticated host connections, as last reported by the server on the main queue.
    private var connectedClients = 0
    /// Hide-for-screenshot hold (#9305); the prototype window stays hidden while it is active.
    private var captureHold = PrototypeCaptureHold(now: { ProcessInfo.processInfo.systemUptime })

    func boot() {
        guard !booted else {
            NSLog("[AutoMobilePrototypeAgent] already booted; ignoring")
            return
        }

        let configuration: PrototypeAgentConfiguration
        switch PrototypeAgentConfiguration.from(environment: ProcessInfo.processInfo.environment) {
        case let .success(parsed):
            configuration = parsed
        case let .failure(failure):
            // Without a host-allocated port and token there is no safe way to listen.
            NSLog("[AutoMobilePrototypeAgent] not starting: %@", failure.description)
            return
        }

        booted = true
        testHooksEnabled = PrototypeTestHooks.isEnabled(environment: ProcessInfo.processInfo.environment)
        NSLog(
            "[AutoMobilePrototypeAgent] %@ (protocol %d) loaded into %@, listening on 127.0.0.1:%d",
            PrototypeAgentProtocol.agentVersion,
            PrototypeAgentProtocol.protocolVersion,
            Bundle.main.bundleIdentifier ?? "?",
            configuration.port
        )
        let server = PrototypeServer(
            configuration: configuration,
            capabilities: model.mode.advertising(PrototypeTestHooks.capabilities(enabled: testHooksEnabled))
        ) { [weak self] message, reply in
            self?.handle(message, reply: reply)
        }
        model.onEvent = { [weak self, weak server] event in
            guard let self else { return }
            for pending in outbox.publish(event) {
                server?.broadcast(pending)
            }
        }
        server.onClientCountChanged = { [weak self] count in self?.clientCountChanged(count) }
        model.onVisibilityChange = { [weak self] visible in self?.setVisible(visible) }
        model.onEndEditing = { [weak self] in _ = self?.window?.endEditing(true) }
        // Session changes deliver the new value before storage and transition side effects,
        // so a dialog opening or closing re-applies the flags at the same point.
        model.onSessionChange = { [weak self] session in
            self?.updateAccessibility(session: session)
            self?.applyInterfaceStyle(session: session)
        }
        model.onSessionChange?(model.session)
        observeKeyboard()
        observeAssistiveEscape()
        observeStorageFlush()
        server.start()
        self.server = server
        installRequestDriver()
    }

    /// Wires the `request` action (#12529): `via: "host"` calls go out as `prototype_request` frames
    /// to the most recently authenticated host (one connection only) and come back as
    /// `prototype_response`; `via: "device"` calls run on a dedicated URLSession client.
    private func installRequestDriver() {
        let driver = PrototypeRequestDriver(
            clock: SystemPrototypeClock(),
            device: PrototypeURLSessionClient()
        ) { [weak self] frame in
            guard let self, connectedClients > 0, let server else { return false }
            server.sendToHost(frame, requestId: frame["requestId"] as? String ?? "")
            return true
        }
        driver.onHostCancel = { [weak self] frame in
            self?.server?.cancelHostRequest(frame, requestId: frame["requestId"] as? String ?? "")
        }
        driver.onHostSettled = { [weak self] requestId in self?.server?.hostRequestFinished(requestId) }
        server?.onHostRequestsLost = { [weak driver] ids in driver?.hostRequestsLost(ids) }
        driver.onComplete = { [weak model] requestId, response in
            model?.completeRequest(requestId, response)
        }
        model.requestDriver = driver
    }

    /// Stored prototype values are debounced; the app going to the background or ending flushes them.
    private func observeStorageFlush() {
        for name in [UIApplication.didEnterBackgroundNotification, UIApplication.willTerminateNotification] {
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(flushStorageNotification(_:)),
                name: name,
                object: nil
            )
        }
    }

    @objc
    private func flushStorageNotification(_: Notification) {
        model.flushStorage()
    }

    /// Selector delivery matches keyboard notifications and stays on the UIKit main actor.
    private func observeAssistiveEscape() {
        syncAssistiveEscape()
        for name in [
            UIAccessibility.voiceOverStatusDidChangeNotification,
            UIAccessibility.switchControlStatusDidChangeNotification,
        ] {
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(assistiveEscapeChanged(_:)),
                name: name,
                object: nil
            )
        }
    }

    @objc
    private func assistiveEscapeChanged(_: Notification) {
        syncAssistiveEscape()
    }

    private func syncAssistiveEscape() {
        model.assistiveEscapeVisible = UIAccessibility.isVoiceOverRunning || UIAccessibility.isSwitchControlRunning
    }

    // MARK: Keyboard

    /// Tracks the app's software keyboard so a bottom sheet can sit above it. The agent runs in the
    /// app's process, so these are the notifications of the keyboard the app shows.
    private func observeKeyboard() {
        let center = NotificationCenter.default
        center.addObserver(
            self,
            selector: #selector(keyboardChanged(_:)),
            name: UIResponder.keyboardWillChangeFrameNotification,
            object: nil
        )
        center.addObserver(
            self,
            selector: #selector(keyboardHidden(_:)),
            name: UIResponder.keyboardWillHideNotification,
            object: nil
        )
    }

    @objc
    private func keyboardChanged(_ note: Notification) {
        let info = note.userInfo
        let frame = (info?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue
        let duration = (info?[UIResponder.keyboardAnimationDurationUserInfoKey] as? NSNumber)?.doubleValue
        model.setKeyboard(frame: frame, duration: duration)
    }

    @objc
    private func keyboardHidden(_ note: Notification) {
        let duration = (note.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? NSNumber)?.doubleValue
        model.setKeyboard(frame: nil, duration: duration)
    }

    @objc
    private func sceneActivated(_: Notification) {
        guard model.spec != nil else { return }
        if let observer = sceneObserver {
            NotificationCenter.default.removeObserver(observer)
            sceneObservers.removeAll { $0 === observer }
        }
        sceneObserver = nil
        setVisible(true)
    }

    // MARK: Window

    private func activeScene() -> UIWindowScene? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        return scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
    }

    // MARK: Appearance

    /// Reads the device's appearance into the model. It comes from the window scene: the prototype
    /// window carries the resolved mode as its own override, so its traits no longer say what the
    /// simulator is set to. Before any scene exists, the process-wide current traits stand in.
    private func syncDeviceAppearance() {
        let traits = (window?.windowScene ?? activeScene())?.traitCollection ?? UITraitCollection.current
        model.setDeviceDark(traits.userInterfaceStyle == .dark)
        model.setDeviceLocales(localeProvider.preferredLanguages)
    }

    /// Puts the resolved mode on the window's UIKit trait, so UIKit-backed pieces (a text field's
    /// keyboard, dynamic `UIColor`s) match what SwiftUI draws. `session` is the incoming value,
    /// delivered before `model.session` is replaced.
    private func applyInterfaceStyle(session: PrototypeSession) {
        guard let window, let appearance = session.appearance else { return }
        let style: UIUserInterfaceStyle = appearance.dark ? .dark : .light
        if window.overrideUserInterfaceStyle != style { window.overrideUserInterfaceStyle = style }
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

    /// Applies `PrototypeHostAccessibility` for `session`. A fullscreen prototype, or an open dialog's
    /// scrim, covers the app, so the app's windows leave the accessibility tree: observe then lists
    /// only prototype nodes, and the app's own toolbars cannot be mistaken for chrome above the
    /// prototype. An open dialog also hides the prototype's own page (#10899) with the UIKit flags the
    /// XCUITest snapshot honours; SwiftUI's `accessibilityHidden` inside one hosting view is not.
    private func updateAccessibility(session: PrototypeSession, force: Bool = false) {
        let flags = PrototypeHostAccessibility(session: session, windowShown: window?.isHidden == false)
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
            let observer = PrototypeSceneActivationObserver { [weak self] note in self?.sceneActivated(note) }
            NotificationCenter.default.addObserver(
                observer,
                selector: #selector(PrototypeSceneActivationObserver.activated(_:)),
                name: UIScene.didActivateNotification,
                object: nil
            )
            sceneObservers.append(observer)
            sceneObserver = observer
            return
        }
        let window = PassthroughWindow(windowScene: scene)
        window.model = model
        model.nativePresentationActive = { [weak window] in window?.rootViewController?.presentedViewController != nil }
        window.windowLevel = .alert + 1
        let layers = PrototypeLayersViewController(model: model)
        window.rootViewController = layers
        self.layers = layers
        window.isHidden = false
        model.safeInsets = window.safeAreaInsets
        model.windowOrigin = window.screenOrigin
        self.window = window
        // A simulator appearance change re-resolves the shown prototype (#11222).
        // The window is attached from the main queue, which is the isolation UIKit asks for here.
        appearanceObservation = scene.registerForTraitChanges(
            [UITraitUserInterfaceStyle.self]
        ) { [weak self] (_: UIWindowScene, _: UITraitCollection) in
            self?.syncDeviceAppearance()
        }
        if localeObservation == nil {
            localeObservation = NotificationCenter.default.addObserver(
                forName: NSLocale.currentLocaleDidChangeNotification, object: nil, queue: .main
            ) { [weak self] _ in
                Task { @MainActor [weak self] in self?.syncDeviceAppearance() }
            }
        }
        syncDeviceAppearance()
        applyInterfaceStyle(session: model.session)
    }

    // MARK: Protocol

    private struct ProtocolResult {
        let requestId: Any
        let started: Date
        let reply: ([String: Any]) -> Void

        func callAsFunction(_ success: Bool, _ error: String? = nil, extra: [String: Any] = [:]) {
            var body: [String: Any] = [
                "type": "prototype_result",
                "requestId": requestId,
                "success": success,
                "totalTimeMs": Int(Date().timeIntervalSince(started) * 1000),
            ]
            if let error { body["error"] = error }
            body.merge(extra) { _, new in new }
            reply(body)
        }
    }

    private func handle(_ message: [String: Any], reply: @escaping ([String: Any]) -> Void) {
        let type = message["type"] as? String ?? ""
        let result = ProtocolResult(requestId: message["requestId"] as Any? ?? NSNull(), started: Date(), reply: reply)
        // The host's answer to a `prototype_request` frame is not a request: nothing replies to it.
        if type == PrototypeRequestWire.responseType {
            model.requestDriver?.receiveHostResponse(message)
            return
        }
        if let rejection = PrototypeTestHooks.rejection(requestType: type, enabled: testHooksEnabled) {
            return result(false, rejection)
        }
        if viewerHosted,
           type == PrototypeAgentProtocol.hideForCaptureRequest || type == PrototypeAgentProtocol
           .restoreAfterCaptureRequest
        {
            return result(false, "not supported by the prototype viewer")
        }
        do {
            switch type {
            case "simulate_tap":
                simulateTap(message, result: result)
            case "show_prototype":
                try showPrototype(message, result: result)
            case PrototypeAgentProtocol.patchRequest:
                try patchPrototype(message, result: result)
            // No update_prototype (#10550): a same-id show_prototype replaces the shown prototype.
            case "dismiss_prototype":
                dismissPrototype(message, result: result)
            case PrototypeAgentProtocol.advanceClockRequest:
                guard let id = message["id"] as? String, !id.isEmpty,
                      let raw = message["advanceTimeMs"] as? NSNumber,
                      CFGetTypeID(raw) != CFBooleanGetTypeID(),
                      raw.doubleValue.rounded() == raw.doubleValue,
                      (1 ... 3_600_000).contains(raw.doubleValue)
                else { return result(false, "advance_prototype_clock needs an id and advanceTimeMs") }
                let advanced = model.advanceClock(id: id, milliseconds: raw.intValue)
                result(advanced.error == nil, advanced.error, extra: ["fired": advanced.fired])
            case PrototypeAgentProtocol.clearStorageRequest:
                clearStorage(message, result: result)
            default: handleAuxiliary(type, message: message, result: result)
            }
        } catch {
            result(false, "Invalid prototype spec: \(error)")
        }
    }

    private func patchPrototype(_ message: [String: Any], result: ProtocolResult) throws {
        // Edits the shown prototype in place (#11675); a refusal leaves it untouched.
        guard let id = message["id"] as? String, !id.isEmpty, let ops = message["ops"] else {
            return result(false, "patch_prototype needs an id and ops")
        }
        let reply = try model.patch(
            id: id,
            baseRevision: (message["baseRevision"] as? NSNumber)?.intValue,
            ops: decode(JSONValue.self, ops)
        ).reply
        result(reply.success, reply.error, extra: reply.extra)
    }

    private func clearStorage(_ message: [String: Any], result: ProtocolResult) {
        // Wipes the stored values of an id (#12526); the shown prototype is left as it is.
        guard let id = message["id"] as? String, !id.isEmpty else {
            return result(false, "clear_prototype_storage needs an id")
        }
        do {
            let cleared = try model.clearStorage(id: id)
            result(true, extra: ["cleared": cleared])
        } catch {
            result(false, "Could not clear stored values for \(id): \(error)")
        }
    }

    private func dismissPrototype(_ message: [String: Any], result: ProtocolResult) {
        // Like Android's PrototypeController: an id that is not the shown prototype fails, and
        // the dismissal still emits the terminal `dismissed` event that event waiters
        // settle on.
        let all = message["all"] as? Bool == true
        guard all || (model.spec != nil && model.spec?.id == message["id"] as? String) else {
            return result(false, "Unknown prototype id: \(message["id"] ?? "nil")")
        }
        model.dismiss(reason: .agent)
        result(true)
    }

    private func simulateTap(_ message: [String: Any], result: ProtocolResult) {
        guard let identifier = message["nodeId"] as? String else {
            return result(false, "simulate_tap needs a nodeId")
        }
        switch model.simulateTap(identifier: identifier) {
        case .success: result(true)
        case .failure(.notShown): result(false, "No prototype is shown")
        case .failure(.notFound): result(false, "No node with testTag \(identifier)")
        case .failure(.notTappable): result(false, "Node \(identifier) has no onTap")
        }
    }

    private func showPrototype(_ message: [String: Any], result: ProtocolResult) throws {
        let spec = try decode(PrototypeSpec.self, message["spec"])
        // The host resolves element anchors to bounds (#9316); drawing one that it did not
        // would silently misplace the node, so the show is refused and nothing changes.
        if let path = spec.root.unresolvedAnchorPath() {
            return result(
                false,
                "\(path): Element anchors must be resolved to bounds by the host; update the AutoMobile host"
            )
        }
        guard let appearance = PrototypeAppearanceOverride.parse(message["appearance"]) else {
            return result(false, "appearance: Expected device, light or dark")
        }
        if let rawLocale = message["locale"],
           (rawLocale as? String)
           .map({ $0.utf16.count <= 35 && PrototypeContractValidator.matches("localeTag", $0) }) != true
        { return result(false, "locale: Invalid locale tag") }
        // The viewer controller owns device appearance; the injected agent reads it here.
        if !viewerHosted { syncDeviceAppearance() }
        model.show(
            spec,
            reset: message["reset"] as? Bool == true,
            appearance: appearance,
            locale: message["locale"] as? String,
            specBytes: message["spec"].flatMap {
                try? JSONSerialization.data(withJSONObject: $0, options: .fragmentsAllowed).count
            }
        )
        if let specJSON = message["spec"] {
            viewerSaveBack?.persistIfSaved(specId: spec.id, specJSON: specJSON)
        }
        warnAboutFontAssets(for: spec)
        warnAboutUnknownThemeColors(for: spec)
        var extra = missingAssetsExtra()
        extra.merge(model.session.navigationSnapshot) { _, navigation in navigation }
        if let appearance = model.session.appearance { extra["appearance"] = appearance.wireObject }
        // The host can leave before this queued show runs; nothing would remove it later.
        if connectedClients == 0 { model.hostDisconnected() }
        result(true, extra: extra)
    }

    private func handleAuxiliary(_ type: String, message: [String: Any], result: ProtocolResult) {
        switch type {
        case "put_prototype_asset":
            putAsset(message, result: result)
        case "remove_prototype_asset":
            if let id = message["id"] as? String { model.removeAsset(id) }
            result(true)
        case "get_prototype_status":
            reportStatus(result: result)
        case "inspect_prototypes" where model.mode == .standalone:
            for pending in outbox.drainForInspect() {
                server?.broadcast(pending)
            }
            var status = model.status()
            status["persistent"] = true
            result(true, extra: [
                "prototypes": model.session.isShown ? [status] : [],
                "droppedEvents": outbox.droppedEvents,
            ])
        case PrototypeAgentProtocol.hideForCaptureRequest:
            hideForCapture(
                deadlineMs: PrototypeCaptureHold
                    .clampedDeadlineMs(message["deadlineMs"])
            ) { hidden, token in
                result(true, extra: ["hidden": hidden, "token": token])
            }
        case PrototypeAgentProtocol.restoreAfterCaptureRequest:
            result(true, extra: ["restored": restoreAfterCapture(token: (message["token"] as? NSNumber)?.intValue)])
        default:
            result(false, "Unknown request type \(type)")
        }
    }

    private func putAsset(_ message: [String: Any], result: ProtocolResult) {
        guard let id = message["id"] as? String,
              let base64 = message["dataBase64"] as? String,
              let data = Data(base64Encoded: base64),
              let image = UIImage(data: data)
        else { return result(false, "Asset must carry an id and a base64 PNG, JPEG or WebP image") }
        model.putAsset(id, image)
        result(true)
    }

    private func reportStatus(result: ProtocolResult) {
        for pending in outbox.drainForInspect() {
            server?.broadcast(pending)
        }
        var status = model.status()
        status["visible"] = viewerHosted || window?.isHidden == false
        if model.mode == .standalone {
            status["persistent"] = true
            status["droppedEvents"] = outbox.droppedEvents
        }
        result(true, extra: ["status": status])
    }

    // MARK: Host connection

    /// The prototype belongs to the host session: when the last authenticated connection closes it
    /// is dismissed (`reason: disconnect`) and its assets dropped, as on Android.
    private func clientCountChanged(_ count: Int) {
        connectedClients = count
        if count < 1 {
            model.hostDisconnected()
            // Calls still waiting on the host (a persistent prototype outlives it) cannot be answered.
            model.requestDriver?.hostDisconnected()
        }
        for pending in outbox.clientCountChanged(count) {
            server?.broadcast(pending)
        }
    }

    // MARK: Hide for capture

    /// Hides the prototype window and replies once the hide has been committed to the render
    /// server, so the host's screenshot cannot still contain it. The hold restores itself at the
    /// deadline, which is what makes a cancelled host safe.
    /// `committed` gets `hidden` (the prototype is off screen because of this hold: it was visible
    /// and is now hidden, or another live hold already hid it) and this hold's token. `hidden:
    /// false` means nothing was visible, so the capture holds no prototype either.
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

    /// `true` when a live hold was released. The prototype comes back only with the last hold.
    private func restoreAfterCapture(token: Int?) -> Bool {
        let release = captureHold.restore(token: token)
        if release.shouldShow { showAfterCapture() }
        return release.released
    }

    private func showAfterCapture() {
        window?.isHidden = model.spec == nil
        updateAccessibility(session: model.session)
    }

    /// One warning per shown spec for font assets without a registered face.
    private func warnAboutFontAssets(for spec: PrototypeSpec) {
        let fonts = model.fontAssets().filter { model.fontFaces[$0] == nil }
        guard !fonts.isEmpty else { return }
        prototypeLog.warning(
            "prototype \(spec.id, privacy: .public): fontFamily asset unsupported on iOS, using system font for \(fonts.joined(separator: ","), privacy: .public)"
        )
    }

    /// `theme.colors` keys that are neither a field nor a Material role are not applied; say so
    /// instead of dropping them silently.
    private func warnAboutUnknownThemeColors(for spec: PrototypeSpec) {
        let unknown = spec.theme?.colors?.unknownKeys ?? []
        guard !unknown.isEmpty else { return }
        prototypeLog.warning(
            "prototype \(spec.id, privacy: .public): ignoring unknown theme.colors keys \(unknown.joined(separator: ","), privacy: .public)"
        )
    }

    private func missingAssetsExtra() -> [String: Any] {
        let missing = model.missingAssets()
        return missing.isEmpty ? [:] : ["missingAssets": missing]
    }

    private func decode<T: Decodable>(_ type: T.Type, _ value: Any?) throws -> T {
        guard let value else { throw NSError(
            domain: "prototype",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "missing field"]
        ) }
        let data = try JSONSerialization.data(withJSONObject: value, options: .fragmentsAllowed)
        return try JSONDecoder().decode(type, from: data)
    }
}
