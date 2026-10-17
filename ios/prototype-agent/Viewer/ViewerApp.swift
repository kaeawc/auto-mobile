import CoreText
import CryptoKit
import SwiftUI
import UIKit

@main
@MainActor
struct PrototypeViewerApp: App {
    @State private var model: PrototypeModel
    private let content: PrototypeViewerContent
    private static let terminationObserver = ViewerTerminationObserver()

    init() {
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
        let layoutDirectory = (documents ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Documents"))
            .appendingPathComponent(PrototypeViewerLayoutLoader.documentsDirectoryName)
        let locations = Bundle.main.path(forResource: "prototype", ofType: "json").map { [$0] } ?? []
        let model = PrototypeModel(mode: .standalone, storage: PrototypeStorageCoordinator.fileBacked())
        model.setDeviceDark(UITraitCollection.current.userInterfaceStyle == .dark)
        let fallback = PrototypeViewerSpecLoader(reader: PrototypeViewerFileReader(), locations: locations)
        let launch: PrototypeViewerLaunch
        if documents != nil {
            launch = PrototypeViewerLayoutLoader(
                reader: PrototypeViewerLayoutReader(), fallback: fallback,
                registrar: PrototypeViewerAssetRegistrar(model: model)
            ).load(directory: layoutDirectory)
        } else {
            launch = PrototypeViewerLaunch(
                content: fallback.load(), registeredImageIds: [], fontFaces: [:], problems: []
            )
        }
        content = launch.content
        model.fontFaces = launch.fontFaces
        model.assetProblems = launch.problems
        if case let .loaded(spec, bytes) = launch.content { model.show(spec, specBytes: bytes) }
        _model = State(initialValue: model)
        let savedSpecId: String?
        if launch.fromSavedLayout, case let .loaded(spec, _) = content {
            savedSpecId = spec.id
        } else {
            savedSpecId = nil
        }
        PrototypeAgent.bootViewerHost(
            model: model, container: NSHomeDirectory(), savedSpecId: savedSpecId, layoutDirectory: layoutDirectory
        )
        _ = Self.terminationObserver
    }

    var body: some Scene {
        WindowGroup {
            switch content {
            case .none:
                Text("No prototype saved")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case let .invalid(path, message):
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Invalid prototype").font(.headline)
                        Text(path).font(.system(.body, design: .monospaced))
                        Text(message)
                    }
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
                }
            case let .unsupportedFormat(version):
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Unsupported prototype format").font(.headline)
                        Text("Version \(version); expected \(PrototypeSavedLayout.formatVersion)")
                    }
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
                }
            case let .corrupt(message):
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Prototype data is corrupt").font(.headline)
                        Text(message)
                    }
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
                }
            case let .loaded(spec, bytes):
                ViewerRenderer(model: model)
                    // Dismissal withdraws hit rects. Recreate the hosts so unchanged geometry
                    // reports them again when the saved prototype is shown again.
                    .id(model.showRevision)
                    .ignoresSafeArea()
                    .onChange(of: model.spec == nil) { _, dismissed in
                        if dismissed { model.show(spec, specBytes: bytes) }
                    }
            }
        }
    }
}

@MainActor
private final class PrototypeViewerAssetRegistrar: PrototypeAssetRegistering {
    let model: PrototypeModel
    private var registeredFontDigests: [String: SHA256.Digest] = [:]

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
        if let registeredDigest = registeredFontDigests[face], registeredDigest != digest { return nil }
        var error: Unmanaged<CFError>?
        let registered = CTFontManagerRegisterGraphicsFont(font, &error)
        let registrationError = error?.takeRetainedValue()
        var alreadyRegistered = false
        if let registrationError, registeredFontDigests[face] == digest {
            alreadyRegistered = CFErrorGetDomain(registrationError) as String == kCTFontManagerErrorDomain as String
                && CFErrorGetCode(registrationError) == CTFontManagerError.alreadyRegistered.rawValue
        }
        guard registered || alreadyRegistered else { return nil }
        registeredFontDigests[face] = digest
        return face
    }
}

@MainActor
private final class ViewerTerminationObserver: NSObject {
    override init() {
        super.init()
        NotificationCenter.default.addObserver(
            self, selector: #selector(terminate(_:)), name: UIApplication.willTerminateNotification, object: nil
        )
        // iOS can kill a suspended app without willTerminate, so stored values flush on backgrounding too.
        NotificationCenter.default.addObserver(
            self, selector: #selector(background(_:)), name: UIApplication.didEnterBackgroundNotification, object: nil
        )
    }

    @objc
    private func background(_: Notification) {
        PrototypeAgent.flushStorage()
    }

    @objc
    private func terminate(_: Notification) {
        PrototypeAgent.flushStorage()
        PrototypeAgent.retractViewerEndpoint()
    }
}

@MainActor
private struct ViewerRenderer: UIViewControllerRepresentable {
    let model: PrototypeModel

    func makeUIViewController(context _: Context) -> ViewerContentController {
        ViewerContentController(model: model)
    }

    func updateUIViewController(_ controller: ViewerContentController, context _: Context) {
        controller.syncAppearance()
    }
}

/// A normal app content controller. Its opaque root receives touches outside authored hit rects;
/// the shared child only routes touches between the renderer's page and modal layers.
@MainActor
private final class ViewerContentController: UIViewController {
    private let model: PrototypeModel
    private let layers: PrototypeLayersViewController
    private weak var observedScene: UIWindowScene?
    private var appearanceObservation: (any UITraitChangeRegistration)?
    private var appliedAccessibility: PrototypeHostAccessibility?

    init(model: PrototypeModel) {
        self.model = model
        layers = PrototypeLayersViewController(model: model)
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
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
        guard let window = view.window else { return }
        let origin = window.convert(CGPoint.zero, to: window.screen.coordinateSpace)
        if model.windowOrigin != origin { model.windowOrigin = origin }
        if model.windowSize != window.bounds.size { model.windowSize = window.bounds.size }
        if model.safeInsets != window.safeAreaInsets { model.safeInsets = window.safeAreaInsets }
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
