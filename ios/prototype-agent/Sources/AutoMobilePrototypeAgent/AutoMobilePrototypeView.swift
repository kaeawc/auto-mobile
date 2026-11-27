#if canImport(UIKit)
    import CryptoKit
    import SwiftUI

    /// Presents a complete prototype inside the embedding app, without an AutoMobile server.
    /// Spec, asset, or storage changes replace the presentation; callback and network changes retain its state.
    @MainActor
    public struct AutoMobilePrototypeView: View {
        private var renderer: PrototypeEmbeddedRenderer
        private var identity: PrototypeEmbeddedIdentity

        /// Decodes and validates the complete spec before rendering. Invalid or unsupported specs
        /// display a visible diagnostic and call `onLoadError` once when that presentation mounts.
        /// Assets use the spec's ids; storage defaults to `.none`. Opt in to persistence for the spec's listed keys.
        /// A dismiss action clears the prototype and calls `onDismiss`; the app decides whether to remove this view.
        public init(
            spec: Data,
            assets: PrototypeAssets = .none,
            storage: PrototypeStorageOption = .none,
            network: PrototypeNetworkConfiguration = .default,
            options: PrototypeEmbeddedOptions = PrototypeEmbeddedOptions(),
            registry: PrototypePlatformRegistry = .system,
            onEvent: @escaping @MainActor (PrototypeEvent) -> Void = { _ in },
            onDismiss: @escaping @MainActor (PrototypeDismissReason) -> Void = { _ in },
            onLoadError: @escaping @MainActor (PrototypeLoadError) -> Void = { _ in }
        ) {
            let registry = registry.withoutSecureStorage
            renderer = PrototypeEmbeddedRenderer(
                spec: spec, assets: assets, storage: storage, network: network, options: options,
                registry: registry,
                onEvent: onEvent, onDismiss: onDismiss, onLoadError: onLoadError
            )
            identity = PrototypeEmbeddedIdentity(
                spec: spec, assets: assets, storage: storage, options: options, registry: registry
            )
        }

        /// Only disposable app hosts opt into their own Keychain namespace; the public view refuses it.
        func standaloneStorage(registry: PrototypePlatformRegistry) -> Self {
            var view = self
            view.renderer.registry = registry
            view.identity.registry = ObjectIdentifier(registry)
            return view
        }

        /// Internal lifecycle seam for app hosts that must reset storage after the final flush.
        func onStopped(_ action: @escaping @MainActor () -> Void) -> Self {
            var view = self
            view.renderer.onStop = action
            return view
        }

        /// Internal seam for app hosts that bound the time to first content (ProtoViewer's render watchdog).
        func onFirstRender(_ action: @escaping @MainActor () -> Void) -> Self {
            var view = self
            view.renderer.onFirstRender = action
            return view
        }

        /// Internal host seam; reports the first resolved mode and subsequent light/dark changes.
        func onAppearanceChange(_ action: @escaping @MainActor (PrototypeChromeAppearance) -> Void) -> Self {
            var view = self
            view.renderer.onAppearanceChange = action
            return view
        }

        /// Internal host seam (#19086): reports a Back action while the prototype handles Back itself
        /// (a pushed route or an open drawer), and nil at its root, where Back should close it.
        func onBackAvailabilityChange(_ action: @escaping @MainActor (PrototypeBackAction?) -> Void) -> Self {
            var view = self
            view.renderer.onBackAvailabilityChange = action
            return view
        }

        /// The embedded renderer or a diagnostic covering the entire presentation.
        public var body: some View {
            renderer.id(identity)
        }
    }

    /// Runs the prototype's own Back once: closes its open drawer or pops its topmost route.
    @MainActor
    struct PrototypeBackAction {
        let perform: @MainActor () -> Void

        func callAsFunction() { perform() }
    }

    private struct PrototypeEmbeddedIdentity: Hashable {
        let spec: SHA256.Digest
        let images: [String: SHA256.Digest]
        let fonts: [String: SHA256.Digest]
        let storage: PrototypeStorageOption
        let options: PrototypeEmbeddedOptions
        var registry: ObjectIdentifier

        init(
            spec: Data,
            assets: PrototypeAssets,
            storage: PrototypeStorageOption,
            options: PrototypeEmbeddedOptions,
            registry: PrototypePlatformRegistry
        ) {
            self.options = options
            self.spec = SHA256.hash(data: spec)
            images = assets.images.mapValues { SHA256.hash(data: $0) }
            fonts = assets.fonts.mapValues { SHA256.hash(data: $0) }
            self.registry = ObjectIdentifier(registry)
            self.storage = storage
        }
    }

    @MainActor
    private struct PrototypeEmbeddedRenderer: UIViewControllerRepresentable {
        let spec: Data
        let assets: PrototypeAssets
        let storage: PrototypeStorageOption
        let network: PrototypeNetworkConfiguration
        let options: PrototypeEmbeddedOptions
        var registry: PrototypePlatformRegistry
        let onEvent: @MainActor (PrototypeEvent) -> Void
        let onDismiss: @MainActor (PrototypeDismissReason) -> Void
        let onLoadError: @MainActor (PrototypeLoadError) -> Void
        var onStop: @MainActor () -> Void = {}
        var onFirstRender: (@MainActor () -> Void)?
        var onAppearanceChange: (@MainActor (PrototypeChromeAppearance) -> Void)?
        var onBackAvailabilityChange: (@MainActor (PrototypeBackAction?) -> Void)?

        private func backCallback(_ controller: PrototypeEmbeddedController) -> (@MainActor (Bool) -> Void)? {
            guard let onBackAvailabilityChange else { return nil }
            // Reported during a session update; deliver host state changes afterwards, as appearance does.
            return { [weak controller] handlesBack in
                let action = handlesBack
                    ? PrototypeBackAction { _ = controller?.popPrototypeBack() }
                    : nil
                Task { @MainActor in onBackAvailabilityChange(action) }
            }
        }

        private func appearanceCallback() -> (@MainActor (PrototypeChromeAppearance) -> Void)? {
            guard let onAppearanceChange else { return nil }
            // UIKit can resolve appearance during a SwiftUI update. Deliver host state changes afterwards.
            return { mode in Task { @MainActor in onAppearanceChange(mode) } }
        }

        @MainActor
        final class Coordinator {
            var onStop: @MainActor () -> Void
            init(onStop: @escaping @MainActor () -> Void) { self.onStop = onStop }
        }

        func makeCoordinator() -> Coordinator { Coordinator(onStop: onStop) }

        func makeUIViewController(context _: Context) -> PrototypeEmbeddedController {
            let controller = PrototypeEmbeddedController(
                spec: spec, assets: assets, storage: storage, network: network, options: options,
                registry: registry,
                onEvent: onEvent, onDismiss: onDismiss, onLoadError: onLoadError
            )
            controller.onFirstRender = onFirstRender
            controller.onAppearanceChange = appearanceCallback()
            controller.onBackAvailabilityChange = backCallback(controller)
            return controller
        }

        func updateUIViewController(_ controller: PrototypeEmbeddedController, context: Context) {
            context.coordinator.onStop = onStop
            controller.updateNetwork(network)
            controller.updateCallbacks(onEvent: onEvent, onDismiss: onDismiss, onLoadError: onLoadError)
            controller.onAppearanceChange = appearanceCallback()
            controller.onBackAvailabilityChange = backCallback(controller)
            controller.syncAppearance()
        }

        static func dismantleUIViewController(_ controller: PrototypeEmbeddedController, coordinator: Coordinator) {
            controller.stop()
            let stopped = coordinator.onStop
            Task { @MainActor in stopped() }
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
#endif
