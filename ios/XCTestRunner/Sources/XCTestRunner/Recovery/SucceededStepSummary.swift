/// A step that completed successfully before the failing step. Mirrors Android `SucceededStepSummary`.
public struct SucceededStepSummary: Equatable, Sendable {
    public let stepIndex: Int
    public let tool: String

    public init(stepIndex: Int, tool: String) {
        self.stepIndex = stepIndex
        self.tool = tool
    }
}
