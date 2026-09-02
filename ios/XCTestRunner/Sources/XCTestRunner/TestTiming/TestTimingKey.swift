/// Lookup key for a test's timing entry.
struct TestTimingKey: Hashable, Sendable {
    let testClass: String
    let testMethod: String
}
