/// The result of an AI recovery attempt. Mirrors Android `RecoveryOutcome`: `success` reflects that a
/// post-recovery observe succeeded (the device is in a queryable state), not a guarantee that the next
/// step's precondition is met — the resumed step itself is the real verification.
public struct RecoveryOutcome: Sendable {
    public let success: Bool
    public let recoveryTimeMs: Int
    public let observeResultAfterRecovery: String?

    public init(success: Bool, recoveryTimeMs: Int = 0, observeResultAfterRecovery: String? = nil) {
        self.success = success
        self.recoveryTimeMs = recoveryTimeMs
        self.observeResultAfterRecovery = observeResultAfterRecovery
    }
}
