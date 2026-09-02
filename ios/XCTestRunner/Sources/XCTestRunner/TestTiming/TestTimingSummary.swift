/// The daemon's `automobile:test-timings` payload. Decode shape frozen with the daemon.
struct TestTimingSummary: Codable, Sendable {
    let testTimings: [TestTimingEntry]
    let generatedAt: String?
    let totalTests: Int
    let totalSamples: Int

    init(
        testTimings: [TestTimingEntry] = [],
        generatedAt: String? = nil,
        totalTests: Int = 0,
        totalSamples: Int = 0
    ) {
        self.testTimings = testTimings
        self.generatedAt = generatedAt
        self.totalTests = totalTests
        self.totalSamples = totalSamples
    }
}
