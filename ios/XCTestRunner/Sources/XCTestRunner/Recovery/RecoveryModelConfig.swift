import Foundation

/// The resolved provider + model for a recovery attempt. `resolve` returns `nil` when the selected
/// provider has no API key in the environment, which the handler treats as "recovery unavailable".
public struct RecoveryModelConfig: Equatable, Sendable {
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
