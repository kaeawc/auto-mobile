/// Reads the `ai-recovery` gate. Mirrors Android `RecoveryConfigProvider`. Refines `Sendable` so the
/// Sendable executor and recovery handler can hold it.
public protocol RecoveryConfigProviding: Sendable {
    func isRecoveryEnabled() -> Bool
    func maxRecoveryToolCalls() -> Int
}
