/// Metadata extracted from a plan's top-level YAML (`platform:` / `devices:`). Internal (the reference
/// kept it `private`) so the rewrite's own tests can assert the parser directly.
struct PlanMetadata {
    let platform: AutoMobilePlanExecutor.PlanPlatform?
    let devicePlatforms: [String: AutoMobilePlanExecutor.PlanPlatform]
    let deviceLabels: [String]
    let hasDevices: Bool
    /// Parameter keys the plan declares sensitive via its top-level `secretParameters:` list. Unioned
    /// with `Configuration.secretParameterKeys` so their substituted values are redacted before any
    /// recovery context reaches the LLM provider (issue #6029).
    let secretParameterKeys: Set<String>
}
