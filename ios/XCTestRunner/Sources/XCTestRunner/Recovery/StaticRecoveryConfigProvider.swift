/// Test double with fixed values. Mirrors Android `StaticRecoveryConfigProvider`. Immutable value
/// type → `Sendable`.
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
