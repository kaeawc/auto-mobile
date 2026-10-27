import Foundation

/// Pure realtime reconnect rules, pinned by the shared `realtime/backoff.json` vectors.
enum PrototypeChannelBackoff {
    static let defaultMaxAttempts = 8
    static let defaultInitialDelayMs = 500
    static let defaultMaxDelayMs = 30000

    /// Full jitter for a one-based retry; rejected attempts consume no random value.
    /// Reconnect bounds are validated by the spec contract; `random` returns a value in `[0, 1)`.
    static func delayMs(
        attempt: Int,
        maxAttempts: Int? = nil,
        initialDelayMs: Int? = nil,
        maxDelayMs: Int? = nil,
        random: () -> Double
    )
        -> Int?
    {
        guard attempt >= 1, attempt <= (maxAttempts ?? defaultMaxAttempts) else { return nil }
        let initial = Double(initialDelayMs ?? defaultInitialDelayMs)
        let ceiling = min(Double(maxDelayMs ?? defaultMaxDelayMs), initial * pow(2, Double(attempt - 1)))
        return Int(floor(random() * floor(ceiling)))
    }
}
