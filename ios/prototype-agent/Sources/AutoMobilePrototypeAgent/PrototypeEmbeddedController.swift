import CoreText
import CryptoKit
import SwiftUI
import UIKit

// Slice 1 intentionally retains the Viewer's copy. Consolidate these hosts and registrars in
// slice 2 alongside the simulator-backed Viewer smoke tests; Viewer behavior is unchanged here.
@MainActor
private final class PrototypeEmbeddedAssetRegistrar: PrototypeAssetRegistering {
    let model: PrototypeModel
    private static var registeredFontDigests: [String: SHA256.Digest] = [:]

    init(model: PrototypeModel) {
        self.model = model
    }

    func registerImage(id: String, data: Data) -> Bool {
        guard let image = UIImage(data: data) else { return false }
        model.putAsset(id, image)
        return true
    }

    func registerFont(id _: String, data: Data) -> String? {
        guard let provider = CGDataProvider(data: data as CFData),
              let font = CGFont(provider), let name = font.postScriptName
        else { return nil }
        let face = name as String
        let digest = SHA256.hash(data: data)
        if let registeredDigest = Self.registeredFontDigests[face], registeredDigest != digest { return nil }
        var error: Unmanaged<CFError>?
        let registered = CTFontManagerRegisterGraphicsFont(font, &error)
        let registrationError = error?.takeRetainedValue()
        var alreadyRegistered = false
        if let registrationError, Self.registeredFontDigests[face] == digest {
            alreadyRegistered = CFErrorGetDomain(registrationError) as String == kCTFontManagerErrorDomain as String
                && CFErrorGetCode(registrationError) == CTFontManagerError.alreadyRegistered.rawValue
        }
        guard registered || alreadyRegistered else { return nil }
        Self.registeredFontDigests[face] = digest
        return face
    }
}

/// A normal app content controller. Its opaque root receives touches outside authored hit rects;
/// the shared child only routes touches between the renderer's page and modal layers.
@MainActor
final class PrototypeEmbeddedController: UIViewController {
    private let model: PrototypeModel
    private let loadError: PrototypeLoadError?
    private var onEvent: (PrototypeEvent) -> Void
    private var onDismiss: (PrototypeDismissReason) -> Void
    private var onLoadError: (PrototypeLoadError) -> Void
    private let layers: PrototypeLayersViewController
    private weak var observedScene: UIWindowScene?
    private var appearanceObservation: (any UITraitChangeRegistration)?
    private var appliedAccessibility: PrototypeHostAccessibility?

    init(
        spec: Data, assets: PrototypeAssets, storage: PrototypeStorageOption,
        network: PrototypeNetworkConfiguration,
        onEvent: @escaping (PrototypeEvent) -> Void,
        onDismiss: @escaping (PrototypeDismissReason) -> Void,
        onLoadError: @escaping (PrototypeLoadError) -> Void
    ) {
        self.onEvent = onEvent
        self.onDismiss = onDismiss
        self.onLoadError = onLoadError
        let loaded: (spec: PrototypeSpec, bytes: Int)?
        do {
            loaded = try PrototypeEmbeddedSpec.load(data: spec)
            loadError = nil
        } catch let error as PrototypeLoadError {
            loaded = nil
            loadError = error
        } catch {
            loaded = nil
            loadError = .invalidSpec(path: "$", message: error.localizedDescription)
        }
        // Invalid/unsupported specs never initialize persistence, start requests, or show a partial tree.
        let model = PrototypeModel(mode: .standalone, storage: loaded == nil ? nil : storage.coordinator())
        self.model = model
        layers = PrototypeLayersViewController(model: model)
        super.init(nibName: nil, bundle: nil)
        guard let loaded else { return }
        let driver = network.driver()
        driver.onComplete = { [weak model] id, response in model?.completeRequest(id, response) }
        model.requestDriver = driver
        model.onEvent = { [weak self] wire in
            do {
                let event = try PrototypeEvent(wire: wire)
                self?.onEvent(event)
                if let reason = event.dismissReason { self?.onDismiss(reason) }
            } catch {
                // Session events contain only JSON values; a violation is a programming error.
                assertionFailure("Non-JSON prototype event: \(error)")
            }
        }
        let registrar = PrototypeEmbeddedAssetRegistrar(model: model)
        for id in assets.images.keys.sorted() {
            if let data = assets.images[id] { _ = registrar.registerImage(id: id, data: data) }
        }
        for id in assets.fonts.keys.sorted() {
            if let data = assets.fonts[id], let face = registrar.registerFont(id: id, data: data) {
                model.fontFaces[id] = face
            }
        }
        model.setDeviceDark(UITraitCollection.current.userInterfaceStyle == .dark)
        model.show(loaded.spec, specBytes: loaded.bytes)
    }

    func updateCallbacks(
        onEvent: @escaping (PrototypeEvent) -> Void,
        onDismiss: @escaping (PrototypeDismissReason) -> Void,
        onLoadError: @escaping (PrototypeLoadError) -> Void
    ) {
        self.onEvent = onEvent
        self.onDismiss = onDismiss
        self.onLoadError = onLoadError
    }

    func stop() {
        model.onEvent = nil
        model.dismiss(reason: .user) // Cancels in-flight requests without a synthetic host dismissal callback.
        model.flushStorage()
        unregisterAppearanceObservation()
        NotificationCenter.default.removeObserver(self)
    }

    @objc
    private func flushStorage(_: Notification) { model.flushStorage() }

    @available(*, unavailable)
    required init?(coder _: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        if let loadError {
            let errorHost = UIHostingController(rootView: PrototypeEmbeddedErrorView(error: loadError))
            addChild(errorHost)
            errorHost.view.frame = view.bounds
            errorHost.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            view.addSubview(errorHost.view)
            errorHost.didMove(toParent: self)
            Task { @MainActor [weak self] in self?.onLoadError(loadError) }
            return
        }
        for name in [UIApplication.didEnterBackgroundNotification, UIApplication.willTerminateNotification] {
            NotificationCenter.default.addObserver(self, selector: #selector(flushStorage(_:)), name: name, object: nil)
        }
        addChild(layers)
        layers.view.frame = view.bounds
        layers.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(layers.view)
        layers.didMove(toParent: self)
        model.onEndEditing = { [weak self] in self?.view.endEditing(true) }
        model.onSessionChange = { [weak self] session in
            self?.apply(session)
        }
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
        for name in [
            UIAccessibility.voiceOverStatusDidChangeNotification,
            UIAccessibility.switchControlStatusDidChangeNotification,
        ] {
            center.addObserver(self, selector: #selector(assistiveEscapeChanged(_:)), name: name, object: nil)
        }
        syncAssistiveEscape()
        syncAppearance()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        syncAppearanceObservation()
        syncAppearance()
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        unregisterAppearanceObservation()
    }

    override func willMove(toParent parent: UIViewController?) {
        if parent == nil { unregisterAppearanceObservation() }
        super.willMove(toParent: parent)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        syncAppearanceObservation()
        guard loadError == nil, let window = view.window else { return }
        // SwiftUI hit rects and anchors use window coordinates; keyboard overlap uses the
        // embedded content rectangle, which can end above the window bottom.
        let origin = window.convert(CGPoint.zero, to: window.screen.coordinateSpace)
        if model.windowOrigin != origin { model.windowOrigin = origin }
        if model.windowSize != window.bounds.size { model.windowSize = window.bounds.size }
        let containerFrame = view.convert(view.bounds, to: window.screen.coordinateSpace)
        if model.keyboardContainerFrame != containerFrame { model.keyboardContainerFrame = containerFrame }
        if model.safeInsets != view.safeAreaInsets { model.safeInsets = view.safeAreaInsets }
        syncAppearance()
    }

    private func syncAppearanceObservation() {
        guard let scene = view.window?.windowScene else {
            unregisterAppearanceObservation()
            return
        }
        guard observedScene !== scene else { return }
        unregisterAppearanceObservation()
        observedScene = scene
        appearanceObservation = scene.registerForTraitChanges(
            [UITraitUserInterfaceStyle.self]
        ) { [weak self] (_: UIWindowScene, _: UITraitCollection) in
            self?.syncAppearance()
        }
    }

    private func unregisterAppearanceObservation() {
        if let observedScene, let appearanceObservation {
            observedScene.unregisterForTraitChanges(appearanceObservation)
        }
        appearanceObservation = nil
        observedScene = nil
    }

    func syncAppearance() {
        guard loadError == nil else { return }
        // Read the scene, as PrototypeAgent.syncDeviceAppearance does: the content's override
        // carries the resolved prototype mode and cannot tell us the device's own setting.
        let traits = view.window?.windowScene?.traitCollection ?? UITraitCollection.current
        model.setDeviceDark(traits.userInterfaceStyle == .dark)
        apply(model.session)
    }

    private func apply(_ session: PrototypeSession) {
        if let appearance = session.appearance {
            let style: UIUserInterfaceStyle = appearance.dark ? .dark : .light
            if overrideUserInterfaceStyle != style { overrideUserInterfaceStyle = style }
        }
        let flags = PrototypeHostAccessibility(session: session, windowShown: true)
        guard flags != appliedAccessibility else { return }
        appliedAccessibility = flags
        layers.apply(flags)
        UIAccessibility.post(notification: .screenChanged, argument: nil)
    }

    @objc
    private func keyboardChanged(_ note: Notification) {
        let frame = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue
        let duration = (note.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? NSNumber)?.doubleValue
        model.setKeyboard(frame: frame, duration: duration)
    }

    @objc
    private func keyboardHidden(_ note: Notification) {
        let duration = (note.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? NSNumber)?.doubleValue
        model.setKeyboard(frame: nil, duration: duration)
    }

    @objc
    private func assistiveEscapeChanged(_: Notification) {
        syncAssistiveEscape()
    }

    private func syncAssistiveEscape() {
        model.assistiveEscapeVisible = UIAccessibility.isVoiceOverRunning || UIAccessibility.isSwitchControlRunning
    }
}
