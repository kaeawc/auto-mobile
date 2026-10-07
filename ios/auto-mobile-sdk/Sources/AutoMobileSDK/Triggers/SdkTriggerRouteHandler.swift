#if DEBUG && !os(watchOS)
    import Foundation
    import os

    /// The result of delivering one trigger to an SDK module.
    enum SdkTriggerOutcome: Equatable, Sendable {
        /// The module acted on the trigger.
        case handled
        /// The module has no trigger with this name.
        case unknownTrigger
        /// The trigger exists but its payload is unusable; the reason is returned to the host.
        case invalidPayload(String)
    }

    /// An SDK module the host can reach through `POST /trigger` (#1580).
    ///
    /// `payload` is the request's `payload` JSON object; modules decode only the fields they need.
    protocol SdkTriggerModule: Sendable {
        /// Trigger names this module accepts, reported back when the host names an unknown one.
        var triggers: [String] { get }
        func handle(trigger: String, payload: [String: Any]) -> SdkTriggerOutcome
    }

    /// Modules registered for host triggers, keyed by module name.
    final class SdkTriggerRegistry: Sendable {
        static let shared = SdkTriggerRegistry(modules: ["biometrics": SdkBiometricsTriggerModule()])

        private let modules: OSAllocatedUnfairLock<[String: any SdkTriggerModule]>

        init(modules: [String: any SdkTriggerModule] = [:]) {
            self.modules = OSAllocatedUnfairLock(initialState: modules)
        }

        func register(_ name: String, module: any SdkTriggerModule) {
            modules.withLock { $0[name] = module }
        }

        func unregister(_ name: String) {
            modules.withLock { _ = $0.removeValue(forKey: name) }
        }

        func module(named name: String) -> (any SdkTriggerModule)? {
            modules.withLock { $0[name] }
        }

        var moduleNames: [String] {
            modules.withLock { $0.keys.sorted() }
        }
    }

    /// Handles `POST /trigger`: `{"module": String, "trigger": String, "payload": {...}?}`.
    ///
    /// Errors are structured so the host can tell a missing module from a wrong trigger name:
    /// `400 bad_request`, `404 module_not_registered` (with `registeredModules`),
    /// `400 unknown_trigger` (with `supportedTriggers`) and `400 invalid_payload` (with `reason`).
    struct SdkTriggerRouteHandler: Sendable {
        private let registry: SdkTriggerRegistry

        init(registry: SdkTriggerRegistry = .shared) {
            self.registry = registry
        }

        func handle(body: Data) -> SdkRouteResponse {
            guard let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
                  let moduleName = object["module"] as? String, !moduleName.isEmpty,
                  let trigger = object["trigger"] as? String, !trigger.isEmpty
            else {
                return Self.response(400, ["error": "bad_request"])
            }
            let payload: [String: Any]
            switch object["payload"] {
            case nil, is NSNull:
                payload = [:]
            case let value as [String: Any]:
                payload = value
            default:
                return Self.response(400, ["error": "bad_request"])
            }
            guard let module = registry.module(named: moduleName) else {
                return Self.response(404, [
                    "error": "module_not_registered",
                    "module": moduleName,
                    "registeredModules": registry.moduleNames,
                ])
            }
            switch module.handle(trigger: trigger, payload: payload) {
            case .handled:
                return Self.response(200, ["status": "ok", "module": moduleName, "trigger": trigger])
            case .unknownTrigger:
                return Self.response(400, [
                    "error": "unknown_trigger",
                    "module": moduleName,
                    "trigger": trigger,
                    "supportedTriggers": module.triggers,
                ])
            case let .invalidPayload(reason):
                return Self.response(400, [
                    "error": "invalid_payload",
                    "module": moduleName,
                    "trigger": trigger,
                    "reason": reason,
                ])
            }
        }

        private static func response(_ statusCode: Int, _ fields: [String: Any]) -> SdkRouteResponse {
            guard let body = try? JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys]) else {
                return SdkRouteResponse(statusCode: 500, body: Data("{\"error\":\"encode_failed\"}".utf8))
            }
            return SdkRouteResponse(statusCode: statusCode, body: body)
        }
    }

    /// Host-triggered biometrics: the iOS counterpart of the Android SDK broadcast in
    /// `src/features/action/BiometricAuth.ts`, with the same `result`/`ttlMs`/`errorCode` fields.
    struct SdkBiometricsTriggerModule: SdkTriggerModule {
        static let defaultTtlMs: Int64 = 5000
        /// Longest override a host may request (10 minutes); larger values are rejected so a stray
        /// trigger cannot leave a stale override armed indefinitely.
        static let maxTtlMs: Int64 = 600_000

        private let override: @Sendable (BiometricResult, Int64) -> Void
        private let clear: @Sendable () -> Void

        init(
            override: @escaping @Sendable (BiometricResult, Int64) -> Void = {
                AutoMobileBiometrics.shared.overrideResult($0, ttlMs: $1)
            },
            clear: @escaping @Sendable () -> Void = { AutoMobileBiometrics.shared.clearOverride() }
        ) {
            self.override = override
            self.clear = clear
        }

        var triggers: [String] {
            ["override", "clear"]
        }

        func handle(trigger: String, payload: [String: Any]) -> SdkTriggerOutcome {
            switch trigger {
            case "override":
                return handleOverride(payload)
            case "clear":
                clear()
                return .handled
            default:
                return .unknownTrigger
            }
        }

        private func handleOverride(_ payload: [String: Any]) -> SdkTriggerOutcome {
            guard let name = payload["result"] as? String else {
                return .invalidPayload("missing_result")
            }
            let ttlMs: Int64
            switch payload["ttlMs"] {
            case nil:
                ttlMs = Self.defaultTtlMs
            case let value as NSNumber
                where Self.isInteger(value) && value.doubleValue > 0 && value.doubleValue <= Double(Self.maxTtlMs):
                ttlMs = value.int64Value
            default:
                return .invalidPayload("invalid_ttl_ms")
            }
            let result: BiometricResult
            switch name.uppercased() {
            case "SUCCESS":
                result = .success
            case "FAILURE":
                result = .failure
            case "CANCEL":
                result = .cancel
            case "ERROR":
                let code: Int
                switch payload["errorCode"] {
                case nil:
                    code = -1
                case let value as NSNumber
                    where Self.isInteger(value) && value.doubleValue >= Double(Int32.min)
                    && value.doubleValue <= Double(Int32.max):
                    code = value.intValue
                default:
                    return .invalidPayload("invalid_error_code")
                }
                result = .error(code: code, message: payload["errorMessage"] as? String ?? "")
            default:
                return .invalidPayload("unknown_result")
            }
            override(result, ttlMs)
            return .handled
        }

        /// JSON booleans and fractions decode as `NSNumber` too; only whole numbers are accepted.
        private static func isInteger(_ value: NSNumber) -> Bool {
            CFGetTypeID(value) != CFBooleanGetTypeID() && value.doubleValue.rounded() == value.doubleValue
        }
    }
#endif
