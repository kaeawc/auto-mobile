/// Per-status sample counts for a test's recorded timing history. Decode shape frozen with the daemon.
struct TestTimingStatusCounts: Codable, Sendable {
    let passed: Int
    let failed: Int
    let skipped: Int

    init(passed: Int = 0, failed: Int = 0, skipped: Int = 0) {
        self.passed = passed
        self.failed = failed
        self.skipped = skipped
    }
}
