/// The LLM provider used for recovery. Key resolution is delegated to Tachikoma (it reads the standard
/// env vars itself); we only need to know which key must be present to decide whether to engage.
public enum RecoveryModelProvider: String, Sendable {
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
