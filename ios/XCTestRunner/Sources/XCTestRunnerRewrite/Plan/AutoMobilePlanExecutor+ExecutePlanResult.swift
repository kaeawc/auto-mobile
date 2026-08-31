extension AutoMobilePlanExecutor {
    public struct FailedStep: Decodable, Sendable {
        public let stepIndex: Int
        public let tool: String
        public let error: String
        public let device: String?
        // The daemon attaches a failure-observation digest to a failed step (src/models/
        // FailureObservation.ts). Decoded here so AI recovery can include it in the agent prompt.
        public let failureObservation: FailureObservationSummary?
    }

    public struct ExecutePlanResult: Decodable, Sendable {
        public let success: Bool
        public let executedSteps: Int
        public let totalSteps: Int
        public let failedStep: FailedStep?
        public let error: String?
        public let platform: String?
        public let deviceMapping: [String: String]?
        // Set by the executor after an AI-recovery attempt (not decoded from the wire). Mirrors the
        // Android result's aiRecoveryAttempted/aiRecoverySuccessful flags.
        public var aiRecoveryAttempted: Bool = false
        public var aiRecoverySuccessful: Bool = false

        private enum CodingKeys: String, CodingKey {
            case success, executedSteps, totalSteps, failedStep, error, platform, deviceMapping
        }
    }
}
