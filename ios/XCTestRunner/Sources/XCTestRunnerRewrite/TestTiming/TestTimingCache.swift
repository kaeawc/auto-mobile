import Foundation

/// Prefetches and caches per-test timing data from the daemon so `AutoMobileTestCase` can order a
/// suite fastest/slowest-first. Best-effort: any fetch/parse failure logs and leaves the cache empty.
///
/// Concurrency (closes race #1): the reference double-checked `loaded` and then read `timingMap`/
/// `summary` — and ran `clear()` — with NO lock, a data race under parallel XCTest workers. Here a
/// single `NSLock` guards `loaded`/`timingMap`/`summary` for EVERY access (prefetch, reads, clear).
/// The lock is held across the one-time daemon fetch (as the reference's `loadLock` was) so the fetch
/// happens exactly once; `NSLock` is used (not an unfair lock) because it is held across that I/O.
/// `@unchecked Sendable`: all mutable state is lock-guarded and `jsonDecoder` is an immutable,
/// used-only-under-lock decoder.
final class TestTimingCache: @unchecked Sendable {
    static let shared = TestTimingCache()

    private let jsonDecoder = JSONDecoder()
    private let lock = NSLock()
    private var loaded = false
    private var timingMap: [TestTimingKey: TestTimingEntry] = [:]
    private var summary: TestTimingSummary?

    private init() {}

    func prefetchIfEnabled() {
        lock.lock()
        defer { lock.unlock() }
        prefetchLocked()
    }

    func getTiming(testClass: String, testMethod: String) -> TestTimingEntry? {
        lock.lock()
        defer { lock.unlock() }
        prefetchLocked()
        return timingMap[TestTimingKey(testClass: testClass, testMethod: testMethod)]
    }

    func hasTimings() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        prefetchLocked()
        return !timingMap.isEmpty
    }

    func getSummary() -> TestTimingSummary? {
        lock.lock()
        defer { lock.unlock() }
        prefetchLocked()
        return summary
    }

    func clear() {
        lock.lock()
        defer { lock.unlock() }
        timingMap = [:]
        summary = nil
        loaded = false
    }

    /// Assumes `lock` is held. Fetches once; subsequent calls are no-ops.
    private func prefetchLocked() {
        guard isEnabled() else {
            return
        }
        if loaded {
            return
        }
        loadFromDaemon()
        loaded = true
    }

    private func isEnabled() -> Bool {
        if isCiMode() {
            return false
        }
        return config.boolValue(forKey: "automobile.junit.timing.enabled", defaultValue: true)
    }

    private func isCiMode() -> Bool {
        if config.boolValue(forKey: "automobile.ci.mode", defaultValue: false) {
            return true
        }
        guard let envValue = ProcessInfo.processInfo.environment["CI"] else {
            return false
        }
        return envValue.lowercased() == "true" || envValue == "1"
    }

    private func loadFromDaemon() {
        let uri = buildRequestUri()
        let timeoutSeconds = Double(resolveTimeoutMs()) / 1000.0
        do {
            let client = try AutoMobileTestTimingClient(environment: AutoMobileEnvironment())
            let payload = try client.readResource(uri: uri, timeout: timeoutSeconds)
            guard let data = payload.data(using: .utf8) else {
                return
            }
            if let jsonObject = try? JSONSerialization.jsonObject(with: data, options: []),
               let object = jsonObject as? [String: Any],
               let error = object["error"] as? String,
               !error.isEmpty
            {
                return
            }
            let parsed = try jsonDecoder.decode(TestTimingSummary.self, from: data)
            summary = parsed
            timingMap = Self.buildTimingMap(from: parsed.testTimings)
        } catch {
            // Best-effort prefetch: timing data is an optimization, so a failure here
            // must not abort the test run. Log it so there is a trace (issue #3618).
            print("[TestTimingCache] Failed to load timing data from daemon: \(error)")
        }
    }

    /// Build the (class, method) → entry lookup from daemon rows.
    ///
    /// The daemon does not guarantee one row per (class, method) — aggregation
    /// bugs, parametrized-variant collisions, or lookback overlap can yield
    /// duplicates. `Dictionary(uniqueKeysWithValues:)` would `fatalError` (an
    /// uncatchable trap) on a duplicate and take down the whole test run, so we
    /// tolerate duplicates and keep the last occurrence instead (issue #3618).
    static func buildTimingMap(from entries: [TestTimingEntry]) -> [TestTimingKey: TestTimingEntry] {
        Dictionary(
            entries.map { (TestTimingKey(testClass: $0.testClass, testMethod: $0.testMethod), $0) },
            uniquingKeysWith: { _, latest in latest }
        )
    }

    private func buildRequestUri() -> String {
        var params: [String: String] = [:]
        params["lookbackDays"] = String(resolvePositiveIntProperty(
            "automobile.junit.timing.lookback.days",
            fallback: 90
        ))
        params["limit"] = String(resolvePositiveIntProperty("automobile.junit.timing.limit", fallback: 1000))
        params["minSamples"] = String(resolveMinSamples())
        params["devicePlatform"] = "ios"

        let sessionUuid = AutoMobileSession.currentSessionUuid()
        if !sessionUuid.isEmpty {
            params["sessionUuid"] = sessionUuid
        }

        return Self.buildRequestUri(parameters: params)
    }

    /// Builds the daemon resource URI using Foundation's query-item encoding.
    ///
    /// Session UUIDs normally contain only URL-safe characters, but treating that
    /// as an invariant would let a future value containing `&` or `=` change the
    /// query structure. `URLComponents` keeps each logical value as one item.
    static func buildRequestUri(parameters: [String: String]) -> String {
        guard !parameters.isEmpty else {
            return "automobile:test-timings"
        }

        var components = URLComponents()
        components.scheme = "automobile"
        components.path = "test-timings"
        components.queryItems = parameters.map { key, value in
            URLQueryItem(name: key, value: value)
        }

        // URLComponents deliberately leaves `+` unescaped. The daemon parses
        // this query with URLSearchParams, where a literal plus is form-decoded
        // as a space, so preserve it as data for that cross-runtime boundary.
        components.percentEncodedQuery = components.percentEncodedQuery?
            .replacingOccurrences(of: "+", with: "%2B")

        // The scheme, path, and logical values above are all valid Foundation
        // components. Keep the protocol's no-query resource URI as a defensive
        // fallback instead of ever emitting a partly encoded query.
        return components.string ?? "automobile:test-timings"
    }

    private func resolveMinSamples() -> Int {
        let value = config.intValue(forKey: "automobile.junit.timing.min.samples", defaultValue: 1)
        return max(0, value)
    }

    private func resolvePositiveIntProperty(_ key: String, fallback: Int) -> Int {
        let value = config.intValue(forKey: key, defaultValue: fallback)
        return value > 0 ? value : fallback
    }

    private func resolveTimeoutMs() -> Int {
        let value = config.intValue(forKey: "automobile.junit.timing.fetch.timeout.ms", defaultValue: 5000)
        return value > 0 ? value : 5000
    }

    private var config: TimingConfig {
        return TimingConfig()
    }
}
