#if canImport(LocalAuthentication)
    import Foundation
    import LocalAuthentication

    @MainActor
    final class LAContextPrototypeBiometricSource: PrototypeBiometricSource {
        private struct Evaluation {
            let id: UUID
            let context: LAContext
            let continuation: CheckedContinuation<PrototypeBiometricOutcome, Never>
        }

        private var evaluation: Evaluation?

        private func policy(_ allowDeviceCredential: Bool) -> LAPolicy {
            allowDeviceCredential ? .deviceOwnerAuthentication : .deviceOwnerAuthenticationWithBiometrics
        }

        func availability(allowDeviceCredential: Bool) -> PrototypeBiometricAvailability {
            let context = LAContext()
            var error: NSError?
            // Check the requested policy itself: credentials work without biometric enrollment.
            if context.canEvaluatePolicy(policy(allowDeviceCredential), error: &error) {
                return .ready(usesFaceID: context.biometryType == .faceID)
            }
            let outcome = Self.outcome(error)
            // Lockout blocks biometrics, not the credential fallback. Let that policy prompt.
            if allowDeviceCredential, outcome == .unavailable(.lockout) {
                return .ready(usesFaceID: context.biometryType == .faceID)
            }
            if case let .unavailable(reason) = outcome {
                return .unavailable(reason, usesFaceID: context.biometryType == .faceID)
            }
            return .platformError
        }

        func evaluate(
            title: String,
            subtitle: String?,
            allowDeviceCredential: Bool
        )
            async -> PrototypeBiometricOutcome
        {
            guard !Task.isCancelled else { return .cancelled }
            let context = LAContext()
            if !allowDeviceCredential { context.localizedFallbackTitle = "" }
            let reason = subtitle.map { title + "\n" + $0 } ?? title
            let id = UUID()
            return await withCheckedContinuation { continuation in
                evaluation = Evaluation(id: id, context: context, continuation: continuation)
                context
                    .evaluatePolicy(
                        policy(allowDeviceCredential),
                        localizedReason: reason
                    ) { [weak self] success, error in
                        let outcome: PrototypeBiometricOutcome = success ? .success : Self.outcome(error)
                        Task { @MainActor in self?.finish(id, outcome: outcome) }
                    }
            }
        }

        private nonisolated static func outcome(_ error: (any Error)?) -> PrototypeBiometricOutcome {
            guard let error = error as? LAError else { return .platformError }
            return .fromLocalAuthenticationErrorCode(error.code.rawValue)
        }

        private func finish(_ id: UUID, outcome: PrototypeBiometricOutcome) {
            guard let evaluation, evaluation.id == id else { return }
            self.evaluation = nil
            evaluation.continuation.resume(returning: outcome)
        }

        func cancel() {
            guard let evaluation else { return }
            self.evaluation = nil
            evaluation.context.invalidate()
            // Resolve immediately; the late LA callback cannot resume this waiter or a new one.
            evaluation.continuation.resume(returning: .cancelled)
        }
    }
#endif
