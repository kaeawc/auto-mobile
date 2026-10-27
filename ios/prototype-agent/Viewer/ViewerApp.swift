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
        PrototypeContentController(model: model, geometry: .window, accessibilityNotification: .screenChanged)
    }

    func updateUIViewController(_ controller: PrototypeContentController, context _: Context) {
        controller.syncAppearance()
    }
}
