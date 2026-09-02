import Foundation

extension AutoMobilePlanExecutor {
    /// Inputs for one plan execution. Not `Sendable` because `planBundle` is a `Bundle` (Foundation
    /// does not mark it `Sendable`); the executor is a synchronous, single-isolation object, so the
    /// configuration never crosses a concurrency boundary and does not need to be.
    public struct Configuration {
        public let transport: Transport
        /// Source checkout whose built daemon should own the managed socket, when available.
        public let daemonRepoRoot: String?
        public let planPath: String
        public let retryCount: Int
        public let timeoutSeconds: TimeInterval
        public let retryDelaySeconds: TimeInterval
        public let startStep: Int
        public let parameters: [String: String]
        public let cleanup: CleanupOptions?
        public let planBundle: Bundle?
        public let defaultPlatform: PlanPlatform
        /// Per-run kill switch for AI-assisted recovery. Mirrors Android's
        /// `AutoMobilePlanExecutionOptions.aiAssistance`. When false, a failed step throws exactly as
        /// before this feature, regardless of the `ai-recovery` flag.
        public let aiAssistance: Bool

        public init(
            transport: Transport,
            planPath: String,
            daemonRepoRoot: String? = nil,
            retryCount: Int = 0,
            timeoutSeconds: TimeInterval = 300,
            retryDelaySeconds: TimeInterval = 1,
            startStep: Int = 0,
            parameters: [String: String] = [:],
            cleanup: CleanupOptions? = nil,
            planBundle: Bundle? = nil,
            defaultPlatform: PlanPlatform = .ios,
            aiAssistance: Bool = true
        ) {
            self.transport = transport
            self.daemonRepoRoot = daemonRepoRoot
            self.planPath = planPath
            self.retryCount = max(0, retryCount)
            self.timeoutSeconds = timeoutSeconds
            self.retryDelaySeconds = retryDelaySeconds
            self.startStep = startStep
            self.parameters = parameters
            self.cleanup = cleanup
            self.planBundle = planBundle
            self.defaultPlatform = defaultPlatform
            self.aiAssistance = aiAssistance
        }
    }
}
