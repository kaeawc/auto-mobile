/// One test's aggregated timing row from the daemon. Decode shape frozen with the daemon.
struct TestTimingEntry: Codable, Sendable {
    let testClass: String
    let testMethod: String
    let averageDurationMs: Int
    let sampleSize: Int
    let lastRun: String?
    let lastRunTimestampMs: Int?
    let successRate: Double?
    let failureRate: Double?
    let stdDevDurationMs: Int?
    let statusCounts: TestTimingStatusCounts?
}
