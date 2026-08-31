/// Attempts AI-assisted recovery of device state after a failed plan step so the plan can resume from
/// the next step. Injected into `AutoMobilePlanExecutor`; the production implementation is
/// `TachikomaPlanRecoveryHandler`, and unit tests inject a fake. Refines `Sendable` so the Sendable
/// executor can hold it.
public protocol PlanRecoveryHandler: Sendable {
    func attemptRecovery(_ context: FailedStepContext) -> RecoveryOutcome
}
