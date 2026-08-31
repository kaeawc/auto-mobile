/// The safely-typed subset of the `failedStep.failureObservation` payload the daemon attaches to a
/// failed `executePlan` result (see src/models/FailureObservation.ts). Heavy hierarchy fields
/// (`viewHierarchy` / `rawViewHierarchy` / `activeWindow`) are intentionally omitted — `Decodable`
/// ignores the unknown keys — so the recovery prompt carries the compact digest, not a full dump.
public struct FailureObservationSummary: Decodable, Equatable, Sendable {
    public let capturedAtMs: Double?
    public let observeError: String?
    public let awaitTimeout: Bool?
    public let visibleTextsSample: [String]?
    public let resourceIdsSample: [String]?

    public init(
        capturedAtMs: Double? = nil,
        observeError: String? = nil,
        awaitTimeout: Bool? = nil,
        visibleTextsSample: [String]? = nil,
        resourceIdsSample: [String]? = nil
    ) {
        self.capturedAtMs = capturedAtMs
        self.observeError = observeError
        self.awaitTimeout = awaitTimeout
        self.visibleTextsSample = visibleTextsSample
        self.resourceIdsSample = resourceIdsSample
    }
}
