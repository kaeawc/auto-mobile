import Foundation

// AI-assisted failure recovery — the iOS counterpart to the Android JUnit runner's recovery loop
// (android/junit-runner … RecoveryTypes.kt / RecoveryConfigProvider.kt). These are the
// dependency-free core types: the executor is wired against the `PlanRecoveryHandler` protocol so it
// stays unit-testable with a fake, while the Tachikoma-backed implementation lives in
// TachikomaPlanRecoveryHandler.swift.

// MARK: - Recovery context types

/// A step that completed successfully before the failing step. Mirrors Android `SucceededStepSummary`.
public struct SucceededStepSummary: Equatable {
    public let stepIndex: Int
    public let tool: String

    public init(stepIndex: Int, tool: String) {
        self.stepIndex = stepIndex
        self.tool = tool
    }
}

/// Everything a `PlanRecoveryHandler` needs to try to get the device back on track after a plan step
/// failed. Mirrors Android `FailedStepContext`.
public struct FailedStepContext {
    public let failedStepIndex: Int
    public let failedTool: String
    public let error: String
    public let succeededSteps: [SucceededStepSummary]
    public let planContent: String
    public let deviceId: String?
    public let failureObservation: FailureObservationSummary?
    /// Platform the plan targets ("ios"/"android"). Injected into every recovery tool call so the
    /// daemon routes it exactly like the plan's own steps.
    public let platform: String
    /// Session the failed plan ran under. Injected into recovery tool calls so they target the same
    /// device/session the plan was using.
    public let sessionUuid: String?

    public init(
        failedStepIndex: Int,
        failedTool: String,
        error: String,
        succeededSteps: [SucceededStepSummary],
        planContent: String,
        platform: String,
        sessionUuid: String? = nil,
        deviceId: String? = nil,
        failureObservation: FailureObservationSummary? = nil
    ) {
        self.failedStepIndex = failedStepIndex
        self.failedTool = failedTool
        self.error = error
        self.succeededSteps = succeededSteps
        self.planContent = planContent
        self.platform = platform
        self.sessionUuid = sessionUuid
        self.deviceId = deviceId
        self.failureObservation = failureObservation
    }
}

/// The result of an AI recovery attempt. Mirrors Android `RecoveryOutcome`: `success` reflects that a
/// post-recovery observe succeeded (the device is in a queryable state), not a guarantee that the next
/// step's precondition is met — the resumed step itself is the real verification.
public struct RecoveryOutcome {
    public let success: Bool
    public let recoveryTimeMs: Int
    public let observeResultAfterRecovery: String?

    public init(success: Bool, recoveryTimeMs: Int = 0, observeResultAfterRecovery: String? = nil) {
        self.success = success
        self.recoveryTimeMs = recoveryTimeMs
        self.observeResultAfterRecovery = observeResultAfterRecovery
    }
}

/// Attempts AI-assisted recovery of device state after a failed plan step so the plan can resume from
/// the next step. Injected into `AutoMobilePlanExecutor`; the production implementation is
/// `TachikomaPlanRecoveryHandler`, and unit tests inject a fake.
public protocol PlanRecoveryHandler {
    func attemptRecovery(_ context: FailedStepContext) -> RecoveryOutcome
}

// MARK: - Failure observation (wire subset)

/// The safely-typed subset of the `failedStep.failureObservation` payload the daemon attaches to a
/// failed `executePlan` result (see src/models/FailureObservation.ts). Heavy hierarchy fields
/// (`viewHierarchy` / `rawViewHierarchy` / `activeWindow`) are intentionally omitted — `Decodable`
/// ignores the unknown keys — so the recovery prompt carries the compact digest, not a full dump.
public struct FailureObservationSummary: Decodable, Equatable {
    public let capturedAtMs: Double?
    public let observeError: String?
    public let awaitTimeout: Bool?
    public let visibleTextsSample: [String]?
    public let resourceIdsSample: [String]?

    public init(
        capturedAtMs: Double? = nil,
        observeError: String? = nil,
        awaitTimeout: Bool? = nil,
        visibleTextsSample: [String]? = nil,
        resourceIdsSample: [String]? = nil
    ) {
        self.capturedAtMs = capturedAtMs
        self.observeError = observeError
        self.awaitTimeout = awaitTimeout
        self.visibleTextsSample = visibleTextsSample
        self.resourceIdsSample = resourceIdsSample
    }
}

// MARK: - Recovery feature-flag configuration

/// Reads the `ai-recovery` gate. Mirrors Android `RecoveryConfigProvider`.
public protocol RecoveryConfigProviding {
    func isRecoveryEnabled() -> Bool
    func maxRecoveryToolCalls() -> Int
}

/// Test double with fixed values. Mirrors Android `StaticRecoveryConfigProvider`.
public struct StaticRecoveryConfigProvider: RecoveryConfigProviding {
    private let enabled: Bool
    private let maxToolCalls: Int

    public init(enabled: Bool = true, maxToolCalls: Int = 5) {
        self.enabled = enabled
        self.maxToolCalls = maxToolCalls
    }

    public func isRecoveryEnabled() -> Bool { enabled }
    public func maxRecoveryToolCalls() -> Int { maxToolCalls }
}

/// Resolves the `ai-recovery` gate by reading the `automobile:config/feature-flags/ai-recovery`
/// resource from the daemon over the shared `AutoMobileMCPClient`. Mirrors Android
/// `DaemonRecoveryConfigProvider`. The result is memoized for the life of the provider (one executor /
/// one test), so at most one resource read happens per test. On any read/parse failure it logs and
/// falls back to the daemon-side defaults (enabled, `maxToolCalls: 5`).
public final class DaemonRecoveryConfigProvider: RecoveryConfigProviding {
    public static let resourceURI = "automobile:config/feature-flags/ai-recovery"
    private static let defaultEnabled = true
    private static let defaultMaxToolCalls = 5

    private let clientProvider: () -> AutoMobileMCPClient?
    private let timeoutSeconds: TimeInterval
    private let logger: AutoMobileLogger
    private var cached: (enabled: Bool, maxToolCalls: Int)?

    public init(
        clientProvider: @escaping () -> AutoMobileMCPClient?,
        timeoutSeconds: TimeInterval = 5,
        logger: AutoMobileLogger = StdoutLogger()
    ) {
        self.clientProvider = clientProvider
        self.timeoutSeconds = timeoutSeconds
        self.logger = logger
    }

    public func isRecoveryEnabled() -> Bool { resolve().enabled }
    public func maxRecoveryToolCalls() -> Int { resolve().maxToolCalls }

    private func resolve() -> (enabled: Bool, maxToolCalls: Int) {
        if let cached = cached {
            return cached
        }
        let resolved = fetch()
        cached = resolved
        return resolved
    }

    private func fetch() -> (enabled: Bool, maxToolCalls: Int) {
        guard let client = clientProvider() else {
            return (Self.defaultEnabled, Self.defaultMaxToolCalls)
        }
        do {
            try client.initialize(timeout: timeoutSeconds)
            let response = try client.readResource(uri: Self.resourceURI, timeout: timeoutSeconds)
            return Self.parse(response.text)
        } catch {
            // Log-then-default: a missing/unreadable flag must not block a test run; the daemon-side
            // default is "enabled", so recovery still engages when a key is configured.
            logger.warn("Failed to read ai-recovery feature flag; defaulting to enabled: \(error)")
            return (Self.defaultEnabled, Self.defaultMaxToolCalls)
        }
    }

    static func parse(_ text: String) -> (enabled: Bool, maxToolCalls: Int) {
        guard let data = text.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data, options: []),
              let dict = object as? [String: Any]
        else {
            return (defaultEnabled, defaultMaxToolCalls)
        }
        let enabled = dict["enabled"] as? Bool ?? defaultEnabled
        var maxToolCalls = defaultMaxToolCalls
        if let config = dict["config"] as? [String: Any], let value = config["maxToolCalls"] as? Int {
            maxToolCalls = value
        }
        return (enabled, maxToolCalls)
    }
}

// MARK: - Model / provider resolution

/// The LLM provider used for recovery. Key resolution is delegated to Tachikoma (it reads the standard
/// env vars itself); we only need to know which key must be present to decide whether to engage.
public enum RecoveryModelProvider: String {
    case anthropic
    case openai
    case google

    /// Env var Tachikoma reads for this provider's key. We gate on its presence so recovery can no-op
    /// cleanly instead of surfacing an authentication error mid-test.
    public var apiKeyEnvVar: String {
        switch self {
        case .anthropic: return "ANTHROPIC_API_KEY"
        case .openai: return "OPENAI_API_KEY"
        case .google: return "GEMINI_API_KEY"
        }
    }

    /// Tachikoma model alias used when `AUTOMOBILE_AI_MODEL` is not set.
    public var defaultModelName: String {
        switch self {
        case .anthropic: return "claude-sonnet-4-20250514"
        case .openai: return "gpt-4.1"
        case .google: return "gemini-2.0-flash"
        }
    }
}

/// The resolved provider + model for a recovery attempt. `resolve` returns `nil` when the selected
/// provider has no API key in the environment, which the handler treats as "recovery unavailable".
public struct RecoveryModelConfig: Equatable {
    public let provider: RecoveryModelProvider
    public let modelName: String

    public init(provider: RecoveryModelProvider, modelName: String) {
        self.provider = provider
        self.modelName = modelName
    }

    /// Env-driven resolution. Provider from `AUTOMOBILE_AI_PROVIDER` (default `anthropic`), model from
    /// `AUTOMOBILE_AI_MODEL` (default = provider's `defaultModelName`). Returns `nil` if the provider's
    /// API-key env var is absent or empty.
    public static func resolve(
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> RecoveryModelConfig? {
        let providerRaw = (environment["AUTOMOBILE_AI_PROVIDER"] ?? "anthropic")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        let provider = RecoveryModelProvider(rawValue: providerRaw) ?? .anthropic

        let apiKey = environment[provider.apiKeyEnvVar]?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let apiKey = apiKey, !apiKey.isEmpty else {
            return nil
        }

        let overrideModel = environment["AUTOMOBILE_AI_MODEL"]?.trimmingCharacters(in: .whitespacesAndNewlines)
        let modelName = (overrideModel?.isEmpty == false ? overrideModel : nil) ?? provider.defaultModelName
        return RecoveryModelConfig(provider: provider, modelName: modelName)
    }
}

// MARK: - Plan step tool-name extraction

/// Best-effort extraction of per-step `tool:` names from a plan's YAML `steps:` list, used to label the
/// "previously succeeded steps" in the recovery prompt. Tolerant by design: the full plan YAML is also
/// handed to the agent, so a missed name degrades to a generic label rather than causing a failure.
public enum PlanStepToolParser {
    public static func toolNames(from yaml: String) -> [String] {
        var names: [String] = []
        var inSteps = false
        var stepsIndent = 0
        var awaitingToolForCurrentItem = false

        for rawLine in yaml.split(whereSeparator: \.isNewline).map(String.init) {
            let line = stripComment(rawLine)
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty {
                continue
            }
            let indent = line.prefix { $0 == " " }.count

            if !inSteps {
                if trimmed == "steps:" || trimmed.hasPrefix("steps:") {
                    inSteps = true
                    stepsIndent = indent
                }
                continue
            }

            // A non-list line at or above the steps key ends the steps block.
            if indent <= stepsIndent, !trimmed.hasPrefix("-") {
                break
            }

            if trimmed.hasPrefix("-") {
                let remainder = trimmed.dropFirst().trimmingCharacters(in: .whitespaces)
                if let tool = toolValue(String(remainder)) {
                    names.append(tool)
                    awaitingToolForCurrentItem = false
                } else {
                    names.append("step")
                    awaitingToolForCurrentItem = true
                }
            } else if awaitingToolForCurrentItem, let tool = toolValue(trimmed), !names.isEmpty {
                names[names.count - 1] = tool
                awaitingToolForCurrentItem = false
            }
        }

        return names
    }

    private static func toolValue(_ text: String) -> String? {
        guard text.hasPrefix("tool:") else {
            return nil
        }
        let value = text.dropFirst("tool:".count).trimmingCharacters(in: .whitespaces)
        if value.isEmpty {
            return nil
        }
        return unquote(String(value))
    }

    private static func stripComment(_ line: String) -> String {
        guard let hashIndex = line.firstIndex(of: "#") else {
            return line
        }
        return String(line[..<hashIndex])
    }

    private static func unquote(_ value: String) -> String {
        guard value.count >= 2 else {
            return value
        }
        if (value.hasPrefix("\"") && value.hasSuffix("\"")) || (value.hasPrefix("'") && value.hasSuffix("'")) {
            return String(value.dropFirst().dropLast())
        }
        return value
    }
}
