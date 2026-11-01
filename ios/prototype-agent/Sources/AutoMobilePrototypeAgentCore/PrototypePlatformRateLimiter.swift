/// Session-local sliding windows. Checking and recording are separate so argument failures and
/// the global in-flight cap never consume a module's budget.
struct PrototypePlatformRateLimiter {
    private let clock: PrototypeClock
    private var timestamps: [String: [Int]] = [:]

    init(clock: PrototypeClock) {
        self.clock = clock
    }

    mutating func refusal(for call: String) -> PlatformCallResult? {
        let module = String(call.prefix { $0 != "." })
        guard let limit = PrototypeContractValidator.platformRateLimit(module) else { return nil }
        let now = clock.nowMilliseconds
        let cutoff = now - limit.windowMs
        let recent = (timestamps[module] ?? []).filter { $0 > cutoff && $0 <= now }
        timestamps[module] = recent
        guard recent.count >= limit.calls else { return nil }
        return .failure(
            .tooManyInFlight,
            "Rate limit exceeded for \(module): at most \(limit.calls) calls per \(limit.windowMs) ms"
        )
    }

    /// Called only after every dispatch gate accepts the call, immediately before it is queued.
    mutating func recordAdmission(for call: String) {
        let module = String(call.prefix { $0 != "." })
        guard PrototypeContractValidator.platformRateLimit(module) != nil else { return }
        timestamps[module, default: []].append(clock.nowMilliseconds)
    }
}
