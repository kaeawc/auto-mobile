import Foundation

/// Configures exponential backoff with jitter for retrying failed event delivery.
public struct RetryPolicy: Sendable {
    public let maxRetries: Int
    public let baseDelayMs: Int
    public let maxDelayMs: Int

    public init(maxRetries: Int = 3, baseDelayMs: Int = 1000, maxDelayMs: Int = 30_000) {
        self.maxRetries = maxRetries
        self.baseDelayMs = baseDelayMs
        self.maxDelayMs = maxDelayMs
    }

    /// Returns whether to retry and the delay in milliseconds, given a status code and attempt number.
    /// Retries on: network failure (0), timeout (408), rate limiting (429), server errors (500-599).
    public func shouldRetry(statusCode: Int, attempt: Int) -> (shouldRetry: Bool, delayMs: Int) {
        guard attempt < maxRetries else { return (false, 0) }
        let retryable = statusCode == 0 || statusCode == 408 || statusCode == 429 ||
                        (statusCode >= 500 && statusCode <= 599)
        guard retryable else { return (false, 0) }
        let delay = min(baseDelayMs * (1 << attempt), maxDelayMs)
        let jitter = Int.random(in: 0...max(1, delay / 4))
        return (true, delay + jitter)
    }
}
