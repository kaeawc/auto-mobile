import Foundation

/// Stable, non-sensitive reasons shared with platform completion metadata.
enum PrototypeBiometricUnavailableReason: String, CaseIterable, Sendable {
    case notEnrolled = "not_enrolled"
    case noHardware = "no_hardware"
    case lockout
    case passcodeNotSet = "passcode_not_set"
    case missingUsageDescription = "missing_usage_description"
}

enum PrototypeBiometricAvailability: Equatable, Sendable {
    case ready(usesFaceID: Bool)
    case unavailable(PrototypeBiometricUnavailableReason, usesFaceID: Bool = false)
    case platformError

    var usesFaceID: Bool {
        switch self {
        case let .ready(usesFaceID), let .unavailable(_, usesFaceID): usesFaceID
        case .platformError: false
        }
    }
}

enum PrototypeBiometricOutcome: Equatable, Sendable {
    case success, attemptFailed, cancelled, platformError
    case unavailable(PrototypeBiometricUnavailableReason)

    /// LocalAuthentication's stable NSError codes (LAPublicDefines.h). Keeping the integer
    /// boundary here lets Core stay framework-free; tests pin it against LAError.Code itself.
    static func fromLocalAuthenticationErrorCode(_ code: Int) -> Self {
        switch code {
        case -1: .attemptFailed // authenticationFailed
        case -2, -3, -4, -9, -1004: .cancelled // userCancel, userFallback, systemCancel, appCancel, notInteractive
        case -5: .unavailable(.passcodeNotSet)
        case -6: .unavailable(.noHardware)
        case -7: .unavailable(.notEnrolled)
        case -8: .unavailable(.lockout)
        default: .platformError
        }
    }
}

@MainActor
protocol PrototypeBiometricSource: AnyObject {
    func availability(allowDeviceCredential: Bool) -> PrototypeBiometricAvailability
    /// Each invocation owns a fresh evaluation context, including after a rejected attempt.
    func evaluate(title: String, subtitle: String?, allowDeviceCredential: Bool) async -> PrototypeBiometricOutcome
    /// Invalidates and resolves the live evaluation once; idle cancellation is a no-op.
    func cancel()
}

/// Presence only: no biometric material, domain state or persistent authentication state.
@MainActor
final class PrototypeBiometricModule: PrototypePlatformModule {
    let name = "biometric"
    let capability = "prototype_platform_biometric_v1"
    let requiredInfoPlistKeys: [String] = []
    var state: [String: JSONValue] { [:] }
    private let source: any PrototypeBiometricSource
    private let bundle: any PrototypeBundleReader
    private var inFlight: UUID?
    private var subscribers: [UUID: AsyncStream<PlatformEvent>.Continuation] = [:]

    init(source: any PrototypeBiometricSource, bundle: any PrototypeBundleReader = PrototypeMainBundleReader()) {
        self.source = source
        self.bundle = bundle
    }

    // Policy depends on call arguments. A driver preflight must not reject passcode-only devices
    // or consult the source before call() can enforce its single-evaluation rule.
    func availability() -> PlatformAvailability { .ready }

    var events: AsyncStream<PlatformEvent> {
        let (stream, continuation) = AsyncStream.makeStream(
            of: PlatformEvent.self, bufferingPolicy: .bufferingNewest(8)
        )
        let id = UUID()
        subscribers[id] = continuation
        continuation.onTermination = { [weak self] _ in
            Task { @MainActor in self?.subscribers[id] = nil }
        }
        return stream
    }

    func call(_ call: PlatformCall) async -> PlatformCallResult {
        guard call.call == "biometric.authenticate" else { return .failure(.unsupported, "Unknown call") }
        if let invalid = PrototypePlatformDriver.invalidArguments(call) { return invalid }
        guard inFlight == nil else {
            return .failure(.tooManyInFlight, "Biometric authentication already in flight")
        }
        guard !Task.isCancelled else { return cancelled }
        let credential = call.args["allowDeviceCredential"] == .bool(true)
        let id = UUID()
        inFlight = id
        defer { if inFlight == id { inFlight = nil } }
        return await withTaskCancellationHandler {
            await authenticate(call, id: id, credential: credential)
        } onCancel: {
            Task { @MainActor [weak self] in self?.cancel(id) }
        }
    }

    private func refusal(credential: Bool) -> PlatformCallResult? {
        let availability = source.availability(allowDeviceCredential: credential)
        if availability.usesFaceID, !bundle.containsInfoPlistKey("NSFaceIDUsageDescription") {
            return .failure(.unavailable, "missing_usage_description")
        }
        switch availability {
        case let .unavailable(reason, _): return .failure(.unavailable, reason.rawValue)
        case .platformError: return .failure(.platformError, "Biometric authentication failed")
        case .ready: return nil
        }
    }

    private func isActive(_ id: UUID) -> Bool { !Task.isCancelled && inFlight == id }

    private func authenticate(_ call: PlatformCall, id: UUID, credential: Bool) async -> PlatformCallResult {
        while isActive(id) {
            if let refusal = refusal(credential: credential) { return refusal }
            let outcome = await source.evaluate(
                title: call.args["title"]?.stringValue ?? "",
                subtitle: call.args["subtitle"]?.stringValue,
                allowDeviceCredential: credential
            )
            guard isActive(id) else {
                cancel(id)
                return cancelled
            }
            switch outcome {
            case .success: return .success(.object([:]))
            case .attemptFailed:
                for value in subscribers.values {
                    value.yield(PlatformEvent(event: "biometric.attemptFailed", data: .object([:])))
                }
            case .cancelled: return cancelled
            case let .unavailable(reason): return .failure(.unavailable, reason.rawValue)
            case .platformError: return .failure(.platformError, "Biometric authentication failed")
            }
        }
        // Cancellation may arrive before the handler's main-actor task. Release ownership
        // synchronously too, so a later call can never inherit the old evaluation.
        cancel(id)
        return cancelled
    }

    private var cancelled: PlatformCallResult { .failure(.cancelled, "Biometric authentication cancelled") }

    private func cancel(_ id: UUID) {
        guard inFlight == id else { return }
        inFlight = nil
        source.cancel()
    }

    func stop() {
        if let inFlight { cancel(inFlight) }
        subscribers.values.forEach { $0.finish() }
        subscribers = [:]
    }
}
