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

    init() { self.init(registry: .system) }

    init(registry: PrototypePlatformRegistry) {
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
        let layoutDirectory = (documents ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Documents"))
            .appendingPathComponent(PrototypeViewerLayoutLoader.documentsDirectoryName)
        let locations = Bundle.main.path(forResource: "prototype", ofType: "json").map { [$0] } ?? []
        let model = PrototypeModel(
            mode: .standalone,
            storage: PrototypeStorageCoordinator.fileBacked(),
            registry: registry
        )
        model.setDeviceDark(UITraitCollection.current.userInterfaceStyle == .dark)
        let fallback = PrototypeViewerSpecLoader(reader: PrototypeViewerFileReader(), locations: locations)
        let launch: PrototypeViewerLaunch
        if documents != nil {
            launch = PrototypeViewerLayoutLoader(
                reader: PrototypeViewerLayoutReader(), fallback: fallback,
                registrar: PrototypeAssetRegistrar(model: model)
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
            case .absent:
                Text("No prototype saved")
                    .accessibilityAddTraits(.isHeader)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case let .invalid(path, message):
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Invalid prototype").font(.headline).accessibilityAddTraits(.isHeader)
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
                        Text("Unsupported prototype format").font(.headline).accessibilityAddTraits(.isHeader)
                        Text("Version \(version); expected \(PrototypeSavedLayout.formatVersion)")
                    }
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
                }
            case let .corrupt(message):
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Prototype data is corrupt").font(.headline).accessibilityAddTraits(.isHeader)
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

    func makeUIViewController(context _: Context) -> PrototypeContentController {
        ViewerContentController(model: model)
    }

    func updateUIViewController(_ controller: PrototypeContentController, context _: Context) {
        controller.syncAppearance()
    }
}

/// Only the standalone viewer emits the recorder handshake; embedded hosts use the base controller.
@MainActor
private final class ViewerContentController: PrototypeContentController {
    private let signal = PrototypeRenderCompleteSignal(
        documents: URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Documents"),
        frames: ViewerRenderFrameSource()
    )
    private var revision: Int?
    private var appeared = false
    private var pendingRevision: Int?

    init(model: PrototypeModel) {
        super.init(model: model, geometry: .window, accessibilityNotification: .screenChanged)
    }

    override func syncAppearance() {
        if revision != model.showRevision, let spec = model.spec {
            revision = model.showRevision
            pendingRevision = nil
            do {
                try signal.beginShow(specId: spec.id, revision: model.showRevision)
            } catch {
                NSLog("Prototype render marker reset failed: %@", String(describing: error))
            }
            view.setNeedsLayout()
        }
        super.syncAppearance()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        appeared = true
        view.setNeedsLayout()
        view.layoutIfNeeded()
    }

    override func viewDidDisappear(_ animated: Bool) {
        appeared = false
        pendingRevision = nil
        signal.cancelPolling()
        super.viewDidDisappear(animated)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        guard appeared, let revision, pendingRevision != revision, let spec = model.spec else { return }
        pendingRevision = revision
        // Let the first presented layout commit before advertising screenshot readiness.
        DispatchQueue.main.async { [weak self] in
            guard let self, appeared, view.window != nil, model.showRevision == revision else { return }
            signal.rendered(specId: spec.id, revision: revision, hasAnimations: { [weak self] in
                guard let self, appeared, view.window != nil,
                      model.showRevision == revision, model.spec?.id == spec.id else { return nil }
                return Self.hasAnimations(in: view.layer)
            }, onError: { error in
                NSLog("Prototype render marker write failed: %@", String(describing: error))
            })
        }
    }

    private static func hasAnimations(in layer: CALayer) -> Bool {
        if let keys = layer.animationKeys(), !keys.isEmpty { return true }
        return layer.sublayers?.contains(where: { hasAnimations(in: $0) }) ?? false
    }
}

@MainActor
private final class ViewerRenderFrameSource: PrototypeRenderFrameSource {
    private var link: CADisplayLink?
    private var frame: (@MainActor () -> Void)?

    func start(_ frame: @escaping @MainActor () -> Void) {
        stop()
        self.frame = frame
        let target = Target()
        target.source = self
        let link = CADisplayLink(target: target, selector: #selector(Target.tick(_:)))
        self.link = link
        link.add(to: .main, forMode: .common)
    }

    func stop() {
        link?.invalidate()
        link = nil
        frame = nil
    }

    /// The run loop retains the link and target, but must not retain a discarded viewer's source.
    @MainActor
    private final class Target: NSObject {
        weak var source: ViewerRenderFrameSource?

        @objc
        func tick(_ link: CADisplayLink) {
            guard let source else {
                link.invalidate()
                return
            }
            source.frame?()
        }
    }
}
