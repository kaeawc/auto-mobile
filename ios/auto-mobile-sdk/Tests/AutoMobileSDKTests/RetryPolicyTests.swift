import XCTest
@testable import AutoMobileSDK

final class RetryPolicyTests: XCTestCase {

    private let policy = RetryPolicy(maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30_000)

    // MARK: - Retryable Status Codes

    func testRetryOnServerError500() {
        let result = policy.shouldRetry(statusCode: 500, attempt: 0)
        XCTAssertTrue(result.shouldRetry)
        XCTAssertGreaterThan(result.delayMs, 0)
    }

    func testRetryOnServerError502() {
        let result = policy.shouldRetry(statusCode: 502, attempt: 0)
        XCTAssertTrue(result.shouldRetry)
    }

    func testRetryOnServerError503() {
        let result = policy.shouldRetry(statusCode: 503, attempt: 0)
        XCTAssertTrue(result.shouldRetry)
    }

    func testRetryOnTimeout408() {
        let result = policy.shouldRetry(statusCode: 408, attempt: 0)
        XCTAssertTrue(result.shouldRetry)
    }

    func testRetryOnRateLimit429() {
        let result = policy.shouldRetry(statusCode: 429, attempt: 0)
        XCTAssertTrue(result.shouldRetry)
    }

    func testRetryOnNetworkFailure0() {
        let result = policy.shouldRetry(statusCode: 0, attempt: 0)
        XCTAssertTrue(result.shouldRetry)
    }

    // MARK: - Non-Retryable Status Codes

    func testNoRetryOn400() {
        let result = policy.shouldRetry(statusCode: 400, attempt: 0)
        XCTAssertFalse(result.shouldRetry)
        XCTAssertEqual(result.delayMs, 0)
    }

    func testNoRetryOn401() {
        let result = policy.shouldRetry(statusCode: 401, attempt: 0)
        XCTAssertFalse(result.shouldRetry)
    }

    func testNoRetryOn403() {
        let result = policy.shouldRetry(statusCode: 403, attempt: 0)
        XCTAssertFalse(result.shouldRetry)
    }

    func testNoRetryOn404() {
        let result = policy.shouldRetry(statusCode: 404, attempt: 0)
        XCTAssertFalse(result.shouldRetry)
    }

    func testNoRetryOnSuccess200() {
        let result = policy.shouldRetry(statusCode: 200, attempt: 0)
        XCTAssertFalse(result.shouldRetry)
    }

    // MARK: - Max Retries Exhausted

    func testNoRetryAfterMaxRetries() {
        let result = policy.shouldRetry(statusCode: 500, attempt: 3)
        XCTAssertFalse(result.shouldRetry)
        XCTAssertEqual(result.delayMs, 0)
    }

    func testNoRetryBeyondMaxRetries() {
        let result = policy.shouldRetry(statusCode: 500, attempt: 5)
        XCTAssertFalse(result.shouldRetry)
    }

    // MARK: - Exponential Backoff

    func testDelayDoublesWithAttempt() {
        // Attempt 0: base * 2^0 = 1000ms + jitter
        let r0 = policy.shouldRetry(statusCode: 500, attempt: 0)
        // Attempt 1: base * 2^1 = 2000ms + jitter
        let r1 = policy.shouldRetry(statusCode: 500, attempt: 1)
        // Attempt 2: base * 2^2 = 4000ms + jitter
        let r2 = policy.shouldRetry(statusCode: 500, attempt: 2)

        XCTAssertTrue(r0.shouldRetry)
        XCTAssertTrue(r1.shouldRetry)
        XCTAssertTrue(r2.shouldRetry)

        // Base delay without jitter: 1000, 2000, 4000
        // With jitter up to delay/4: max 1250, 2500, 5000
        XCTAssertGreaterThanOrEqual(r0.delayMs, 1000)
        XCTAssertLessThanOrEqual(r0.delayMs, 1250)

        XCTAssertGreaterThanOrEqual(r1.delayMs, 2000)
        XCTAssertLessThanOrEqual(r1.delayMs, 2500)

        XCTAssertGreaterThanOrEqual(r2.delayMs, 4000)
        XCTAssertLessThanOrEqual(r2.delayMs, 5000)
    }

    // MARK: - Max Delay Cap

    func testDelayIsCappedAtMaxDelay() {
        let bigPolicy = RetryPolicy(maxRetries: 20, baseDelayMs: 10000, maxDelayMs: 30_000)
        let result = bigPolicy.shouldRetry(statusCode: 500, attempt: 10)
        XCTAssertTrue(result.shouldRetry)
        // maxDelayMs=30000 + jitter up to 30000/4=7500
        XCTAssertLessThanOrEqual(result.delayMs, 37500)
    }

    // MARK: - Jitter Is Bounded

    func testJitterIsBounded() {
        // Run multiple times to verify jitter stays in range
        for _ in 0..<100 {
            let result = policy.shouldRetry(statusCode: 500, attempt: 0)
            // Base delay = 1000, jitter in 0..250
            XCTAssertGreaterThanOrEqual(result.delayMs, 1000)
            XCTAssertLessThanOrEqual(result.delayMs, 1250)
        }
    }

    // MARK: - Default Initialization

    func testDefaultValues() {
        let defaultPolicy = RetryPolicy()
        XCTAssertEqual(defaultPolicy.maxRetries, 3)
        XCTAssertEqual(defaultPolicy.baseDelayMs, 1000)
        XCTAssertEqual(defaultPolicy.maxDelayMs, 30_000)
    }
}
