#if canImport(UIKit)
    import SwiftUI
    import UIKit

    @MainActor
    final class PrototypeEmbeddedController: PrototypeContentController {
        private let loadError: PrototypeLoadError?
        private var onEvent: @MainActor (PrototypeEvent) -> Void
        private var onDismiss: @MainActor (PrototypeDismissReason) -> Void
        private var onLoadError: @MainActor (PrototypeLoadError) -> Void
        /// Fires once, the first time the shown prototype is laid out in a window. App hosts use it
        /// to stop their render watchdog; never fires for an invalid spec.
        var onFirstRender: (@MainActor () -> Void)?
        init(
            spec: Data, assets: PrototypeAssets, storage: PrototypeStorageOption,
            network: PrototypeNetworkConfiguration,
            registry: PrototypePlatformRegistry = .empty,
            onEvent: @escaping @MainActor (PrototypeEvent) -> Void,
            onDismiss: @escaping @MainActor (PrototypeDismissReason) -> Void,
            onLoadError: @escaping @MainActor (PrototypeLoadError) -> Void
        ) {
            self.onEvent = onEvent
            self.onDismiss = onDismiss
            self.onLoadError = onLoadError
            let loaded: (spec: PrototypeSpec, bytes: Int)?
            do {
                loaded = try PrototypeEmbeddedSpec.load(
                    data: spec,
                    supported: AutoMobilePrototypeCapabilities.supported + registry.capabilities
                )
                loadError = nil
            } catch let error as PrototypeLoadError {
                loaded = nil
                loadError = error
            } catch {
                loaded = nil
                loadError = .invalidSpec(path: "$", message: error.localizedDescription)
            }
            // Invalid/unsupported specs never initialize persistence, start requests, or show a partial tree.
            let model = PrototypeModel(
                mode: .standalone,
                storage: loaded == nil ? nil : storage.coordinator(),
                registry: registry
            )
            super.init(model: model, contentEnabled: loaded != nil)
            guard let loaded else { return }
            let driver = network.driver()
            driver.onComplete = { [weak model] id, response in model?.completeRequest(id, response) }
            model.requestDriver = driver
            model.onEmbeddedEvent = { [weak self] event in
                self?.onEvent(event)
                if let reason = event.dismissReason { self?.onDismiss(reason) }
            }
            let registrar = PrototypeAssetRegistrar(model: model, fontRegistrationScope: .process)
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

        override func viewDidLayoutSubviews() {
            super.viewDidLayoutSubviews()
            guard loadError == nil, model.spec != nil, view.window != nil, let ready = onFirstRender else { return }
            onFirstRender = nil
            ready()
        }

        func updateNetwork(_ network: PrototypeNetworkConfiguration) {
            if let driver = model.requestDriver { network.apply(to: driver) }
        }

        func updateCallbacks(
            onEvent: @escaping @MainActor (PrototypeEvent) -> Void,
            onDismiss: @escaping @MainActor (PrototypeDismissReason) -> Void,
            onLoadError: @escaping @MainActor (PrototypeLoadError) -> Void
        ) {
            self.onEvent = onEvent
            self.onDismiss = onDismiss
            self.onLoadError = onLoadError
        }

        func stop() {
            model.onEmbeddedEvent = nil
            model.dismiss(reason: .user) // Cancels in-flight requests without a synthetic host dismissal callback.
            model.flushStorage()
            stopObserving()
        }

        @objc
        private func flushStorage(_: Notification) { model.flushStorage() }

        @available(*, unavailable)
        required init?(coder _: NSCoder) {
            fatalError("init(coder:) is not supported")
        }

        override func loadContent() {
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
                NotificationCenter.default.addObserver(
                    self,
                    selector: #selector(flushStorage(_:)),
                    name: name,
                    object: nil
                )
            }
            super.loadContent()
        }
    }
#endif
