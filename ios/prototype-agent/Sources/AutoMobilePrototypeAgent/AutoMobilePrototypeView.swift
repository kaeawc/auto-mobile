import SwiftUI

/// Presents a complete prototype inside the embedding app, without an AutoMobile server.
/// Configuration changes replace the presentation; callback changes retain its current state.
@MainActor
public struct AutoMobilePrototypeView: View {
    private let renderer: PrototypeEmbeddedRenderer
    private let identity: PrototypeEmbeddedIdentity

    /// Decodes and validates the complete spec before rendering. Invalid or unsupported specs
    /// display a visible diagnostic and call `onLoadError` once when that presentation mounts.
    /// Assets use the spec's ids; storage persists only the spec's listed keys. A dismiss action
    /// clears the prototype and calls `onDismiss`; the app decides whether to remove this view.
    public init(
        spec: Data,
        assets: PrototypeAssets = .none,
        storage: PrototypeStorageOption = .fileBacked,
        network: PrototypeNetworkConfiguration = .default,
        onEvent: @escaping (PrototypeEvent) -> Void = { _ in },
        onDismiss: @escaping (PrototypeDismissReason) -> Void = { _ in },
        onLoadError: @escaping (PrototypeLoadError) -> Void = { _ in }
    ) {
        renderer = PrototypeEmbeddedRenderer(
            spec: spec, assets: assets, storage: storage, network: network,
            onEvent: onEvent, onDismiss: onDismiss, onLoadError: onLoadError
        )
        identity = PrototypeEmbeddedIdentity(spec: spec, assets: assets, storage: storage, network: network.identifier)
    }

    /// The embedded renderer or a diagnostic covering the entire presentation.
    public var body: some View {
        renderer.id(identity)
    }
}

private struct PrototypeEmbeddedIdentity: Hashable {
    let spec: Data
    let assets: PrototypeAssets
    let storage: PrototypeStorageOption
    let network: ObjectIdentifier
}

@MainActor
private struct PrototypeEmbeddedRenderer: UIViewControllerRepresentable {
    let spec: Data
    let assets: PrototypeAssets
    let storage: PrototypeStorageOption
    let network: PrototypeNetworkConfiguration
    let onEvent: (PrototypeEvent) -> Void
    let onDismiss: (PrototypeDismissReason) -> Void
    let onLoadError: (PrototypeLoadError) -> Void

    func makeUIViewController(context _: Context) -> PrototypeEmbeddedController {
        PrototypeEmbeddedController(
            spec: spec, assets: assets, storage: storage, network: network,
            onEvent: onEvent, onDismiss: onDismiss, onLoadError: onLoadError
        )
    }

    func updateUIViewController(_ controller: PrototypeEmbeddedController, context _: Context) {
        controller.updateCallbacks(onEvent: onEvent, onDismiss: onDismiss, onLoadError: onLoadError)
        controller.syncAppearance()
    }

    static func dismantleUIViewController(_ controller: PrototypeEmbeddedController, coordinator _: ()) {
        controller.stop()
    }
}

struct PrototypeEmbeddedErrorView: View {
    let error: PrototypeLoadError

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("Unable to load prototype").font(.headline)
                Text(error.localizedDescription)
            }
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(uiColor: .systemBackground))
    }
}
