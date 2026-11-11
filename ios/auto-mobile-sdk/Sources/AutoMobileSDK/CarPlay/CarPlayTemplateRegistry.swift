import Foundation

@MainActor
protocol CarPlayTemplateSource: AnyObject {
    func carPlaySnapshot() -> CarPlayTemplateDocument
}

@MainActor
final class CarPlayTemplateRegistry {
    static let shared = CarPlayTemplateRegistry()
    private(set) var enabled = false
    private weak var controller: (any CarPlayTemplateSource)?

    func register(_ controller: any CarPlayTemplateSource) {
        enabled = true
        self.controller = controller
    }

    func unregister() {
        controller = nil
    }

    func snapshot() -> CarPlayTemplateDocument {
        controller?.carPlaySnapshot() ?? CarPlayTemplateDocument(enabled: enabled)
    }
}

#if canImport(CarPlay)
    import CarPlay

    extension CPInterfaceController: CarPlayTemplateSource {
        func carPlaySnapshot() -> CarPlayTemplateDocument {
            var mapper = CarPlayTemplateMapper()
            return mapper.document(templates: templates, presented: presentedTemplate)
        }
    }

    extension AutoMobileSDK {
        /// Opt in to read-only snapshots of this controller. The SDK retains it weakly.
        @MainActor
        public func registerCarPlay(interfaceController: CPInterfaceController) {
            #if DEBUG
                CarPlayTemplateRegistry.shared.register(interfaceController)
            #endif
        }

        /// Disconnect the controller; the snapshot continues to report the prior opt-in.
        @MainActor
        public func unregisterCarPlay() {
            #if DEBUG
                CarPlayTemplateRegistry.shared.unregister()
            #endif
        }
    }
#endif
