/// Everything a `PlanRecoveryHandler` needs to try to get the device back on track after a plan step
/// failed. Mirrors Android `FailedStepContext`.
public struct FailedStepContext: Sendable {
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
