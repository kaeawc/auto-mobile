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

    func perform(
        _ request: CarPlayActionRequest,
        completion: @escaping @MainActor (CarPlayActionResponse) -> Void
    ) {
        let finish: @MainActor (CarPlayActionOutcome) -> Void = { outcome in
            completion(CarPlayActionResponse(
                status: outcome.status, reason: outcome.reason, id: request.id,
                action: request.action, templates: self.snapshot()
            ))
        }
        guard enabled, let controller else {
            finish(CarPlayActionOutcome(
                status: .unsupported,
                reason: enabled ? "No CarPlay controller is connected." :
                    "The app has not opted in with registerCarPlay."
            ))
            return
        }
        guard let source = controller as? any CarPlayActionSource else {
            finish(CarPlayActionOutcome(status: .unsupported, reason: "The CarPlay source does not support actions."))
            return
        }
        switch request.action {
        case .select:
            guard request.isValid, let id = request.id else {
                finish(CarPlayActionOutcome(status: .failed, reason: "select requires a nonempty id."))
                return
            }
            finish(source.carPlaySelect(id: id))
        case .back, .popToRoot:
            source.carPlayPop(toRoot: request.action == .popToRoot, completion: finish)
        }
    }

    func snapshot() -> CarPlayTemplateDocument {
        controller?.carPlaySnapshot() ?? CarPlayTemplateDocument(enabled: enabled)
    }
}

#if canImport(CarPlay)
    import CarPlay

    extension CPInterfaceController: CarPlayActionSource {
        func carPlaySelect(id: String) -> CarPlayActionOutcome {
            CarPlayActionPerformer().select(id: id, templates: templates, presented: presentedTemplate)
        }

        func carPlayPop(toRoot: Bool, completion: @escaping @MainActor (CarPlayActionOutcome) -> Void) {
            let finished: (Bool, (any Error)?) -> Void = { success, error in
                let outcome = CarPlayActionOutcome(
                    status: success ? .success : .failed,
                    reason: success ? nil : (error?.localizedDescription ?? "No template was popped.")
                )
                DispatchQueue.main.async { completion(outcome) }
            }
            if toRoot {
                popToRootTemplate(animated: false, completion: finished)
            } else {
                popTemplate(animated: false, completion: finished)
            }
        }

        func carPlaySnapshot() -> CarPlayTemplateDocument {
            var mapper = CarPlayTemplateMapper()
            return mapper.document(templates: templates, presented: presentedTemplate)
        }
    }

    extension AutoMobileSDK {
        /// Opt in to debug snapshots and actions for this controller. The SDK retains it weakly.
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
