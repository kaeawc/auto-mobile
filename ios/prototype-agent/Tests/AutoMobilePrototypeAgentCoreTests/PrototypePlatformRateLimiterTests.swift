@testable import AutoMobilePrototypeAgentCore
import XCTest

private final class RateLimitClock: PrototypeClock {
    var nowMilliseconds = 0
    var monotonicMilliseconds = 0

    func schedule(afterMilliseconds _: Int, _: @escaping () -> Void) -> PrototypeTimerHandle {
        XCTFail("Rate limiting must not schedule timers")
        return RateLimitTimerHandle()
    }
}

private final class RateLimitTimerHandle: PrototypeTimerHandle {
    func cancel() {}
}

final class PrototypePlatformRateLimiterTests: XCTestCase {
    private let shareRefusal = PlatformCallResult.failure(
        .tooManyInFlight, "Rate limit exceeded for share: at most 5 calls per 10000 ms"
    )

    private func admit(_ call: String, using limiter: inout PrototypePlatformRateLimiter) -> PlatformCallResult? {
        if let refusal = limiter.refusal(for: call) { return refusal }
        limiter.recordAdmission(for: call)
        return nil
    }

    func testContractRateLimitsDecode() throws {
        let share = try XCTUnwrap(PrototypeContractValidator.platformRateLimit("share"))
        XCTAssertEqual(share.calls, 5)
        XCTAssertEqual(share.windowMs, 10000)
        let notifications = try XCTUnwrap(PrototypeContractValidator.platformRateLimit("notifications"))
        XCTAssertEqual(notifications.calls, 10)
        XCTAssertEqual(notifications.windowMs, 60000)
        XCTAssertNil(PrototypeContractValidator.platformRateLimit("clipboard"))
    }

    func testShareAllowsFiveCallsAndRefusesSixth() {
        var limiter = PrototypePlatformRateLimiter(clock: RateLimitClock())
        for _ in 0 ..< 5 {
            XCTAssertNil(admit("share.open", using: &limiter))
        }
        XCTAssertEqual(admit("share.open", using: &limiter), shareRefusal)
    }

    func testBackwardWallClockStepDoesNotResetBudget() {
        let clock = RateLimitClock()
        clock.nowMilliseconds = 100_000
        var limiter = PrototypePlatformRateLimiter(clock: clock)
        for _ in 0 ..< 5 {
            XCTAssertNil(admit("share.open", using: &limiter))
        }
        clock.nowMilliseconds = 90000
        clock.monotonicMilliseconds = 9999
        XCTAssertEqual(admit("share.open", using: &limiter), shareRefusal)
        clock.monotonicMilliseconds = 10000
        XCTAssertNil(admit("share.open", using: &limiter))
    }

    func testWindowExpiresAtExactBoundary() {
        let clock = RateLimitClock()
        var limiter = PrototypePlatformRateLimiter(clock: clock)
        for _ in 0 ..< 5 {
            XCTAssertNil(admit("share.open", using: &limiter))
        }
        clock.monotonicMilliseconds = 9999
        XCTAssertEqual(admit("share.open", using: &limiter), shareRefusal)
        clock.monotonicMilliseconds = 10000
        XCTAssertNil(admit("share.open", using: &limiter))
    }

    func testSlidingWindowRetainsLaterAdmissions() {
        let clock = RateLimitClock()
        var limiter = PrototypePlatformRateLimiter(clock: clock)
        XCTAssertNil(admit("share.open", using: &limiter))
        clock.monotonicMilliseconds = 5000
        for _ in 0 ..< 4 {
            XCTAssertNil(admit("share.open", using: &limiter))
        }
        clock.monotonicMilliseconds = 10000
        XCTAssertNil(admit("share.open", using: &limiter))
        XCTAssertEqual(admit("share.open", using: &limiter), shareRefusal)
        clock.monotonicMilliseconds = 15000
        for _ in 0 ..< 4 {
            XCTAssertNil(admit("share.open", using: &limiter))
        }
        XCTAssertEqual(admit("share.open", using: &limiter), shareRefusal)
    }

    func testRefusalsDoNotConsumeBudget() {
        let clock = RateLimitClock()
        var limiter = PrototypePlatformRateLimiter(clock: clock)
        for _ in 0 ..< 5 {
            XCTAssertNil(admit("share.open", using: &limiter))
        }
        clock.monotonicMilliseconds = 9999
        for _ in 0 ..< 3 {
            XCTAssertEqual(admit("share.open", using: &limiter), shareRefusal)
        }
        clock.monotonicMilliseconds = 10000
        for _ in 0 ..< 5 {
            XCTAssertNil(admit("share.open", using: &limiter))
        }
        XCTAssertEqual(admit("share.open", using: &limiter), shareRefusal)
    }

    func testModuleBudgetsAreIndependentAndClipboardIsUnlimited() {
        var limiter = PrototypePlatformRateLimiter(clock: RateLimitClock())
        for _ in 0 ..< 5 {
            XCTAssertNil(admit("share.open", using: &limiter))
        }
        XCTAssertEqual(admit("share.open", using: &limiter), shareRefusal)
        for _ in 0 ..< 10 {
            XCTAssertNil(admit("notifications.post", using: &limiter))
        }
        for _ in 0 ..< 100 {
            XCTAssertNil(admit("clipboard.copy", using: &limiter))
            XCTAssertNil(admit("clipboard.paste", using: &limiter))
        }
    }

    func testNotificationsShareTenCallBudgetPerMinute() {
        let clock = RateLimitClock()
        var limiter = PrototypePlatformRateLimiter(clock: clock)
        for _ in 0 ..< 5 {
            XCTAssertNil(admit("notifications.post", using: &limiter))
            XCTAssertNil(admit("notifications.schedule", using: &limiter))
        }
        let refusal = PlatformCallResult.failure(
            .tooManyInFlight, "Rate limit exceeded for notifications: at most 10 calls per 60000 ms"
        )
        XCTAssertEqual(admit("notifications.setBadge", using: &limiter), refusal)
        clock.monotonicMilliseconds = 59999
        XCTAssertEqual(admit("notifications.post", using: &limiter), refusal)
        clock.monotonicMilliseconds = 60000
        for _ in 0 ..< 10 {
            XCTAssertNil(admit("notifications.setBadge", using: &limiter))
        }
        XCTAssertEqual(admit("notifications.post", using: &limiter), refusal)
    }

    private func session(clock: RateLimitClock) throws -> PrototypeSession {
        let raw = """
        {"id":"rate-limit","window":{"placement":{"type":"fullscreen"}},
         "requires":{"platform":["share","notifications","clipboard"]},
         "data":{},"state":{"status":"idle"},"root":{"type":"spacer"}}
        """
        var session = PrototypeSession(clock: clock)
        try session.show(JSONDecoder().decode(PrototypeSpec.self, from: Data(raw.utf8)))
        return session
    }

    private func shareAction() throws -> PrototypeAction {
        try JSONDecoder().decode(PrototypeAction.self, from: Data("""
        {"type":"platform","call":"share.open","statusKey":"status",
         "into":"/data/share","args":{"text":{"value":"hello"}},
         "onError":[{"type":"emit","name":"refused"}]}
        """.utf8))
    }

    private func start(_ action: PrototypeAction, in session: inout PrototypeSession) throws -> String {
        _ = session.run([action])
        let commands = session.takePlatformCommands()
        XCTAssertEqual(commands.count, 1)
        guard case let .start(job)? = commands.first else {
            throw NSError(domain: "Missing platform start", code: 1)
        }
        return job.call.callId
    }

    func testSessionRateLimitedCallIsNotQueuedOrInFlight() throws {
        let clock = RateLimitClock()
        var session = try session(clock: clock)
        let action = try shareAction()
        for _ in 0 ..< 5 {
            let id = try start(action, in: &session)
            _ = session.completePlatformCall(id, .success(.null), durationMs: 0)
        }
        let events = session.run([action])
        let payload = try XCTUnwrap(events.first { $0.name == "prototype_platform" }?.payload.objectFields)
        XCTAssertEqual(payload["error"], .object([
            "code": .string(PlatformErrorCode.tooManyInFlight.rawValue),
            "message": .string("Rate limit exceeded for share: at most 5 calls per 10000 ms"),
        ]))
        XCTAssertEqual(payload["durationMs"], .number(0))
        XCTAssertEqual(session.state["status"], .string("error"))
        XCTAssertEqual(events.last?.name, "refused")
        XCTAssertTrue(session.takePlatformCommands().isEmpty)
        let refusedId = try XCTUnwrap(payload["callId"]?.stringValue)
        XCTAssertTrue(session.completePlatformCall(refusedId, .success(.null), durationMs: 1).isEmpty)
        clock.monotonicMilliseconds = 10000
        for _ in 0 ..< 5 {
            let id = try start(action, in: &session)
            _ = session.completePlatformCall(id, .success(.null), durationMs: 0)
        }
    }

    func testSessionRateLimitPrecedesInFlightLimit() throws {
        var session = try session(clock: RateLimitClock())
        // Calls without `into` do not supersede one another.
        let action = try JSONDecoder().decode(PrototypeAction.self, from: Data("""
        {"type":"platform","call":"share.open","args":{"text":{"value":"hello"}}}
        """.utf8))
        let first = try start(action, in: &session)
        _ = session.completePlatformCall(first, .success(.null), durationMs: 0)
        for _ in 0 ..< 4 {
            _ = try start(action, in: &session)
        }
        let events = session.run([action])
        let payload = try XCTUnwrap(events.last?.payload.objectFields)
        XCTAssertEqual(
            payload["error"]?.objectFields?["message"],
            .string("Rate limit exceeded for share: at most 5 calls per 10000 ms")
        )
        XCTAssertTrue(session.takePlatformCommands().isEmpty)
    }

    func testSessionInFlightRefusalDoesNotConsumeBudget() throws {
        var session = try session(clock: RateLimitClock())
        let action = try JSONDecoder().decode(PrototypeAction.self, from: Data("""
        {"type":"platform","call":"share.open","args":{"text":{"value":"hello"}}}
        """.utf8))
        var ids: [String] = []
        for _ in 0 ..< 4 {
            try ids.append(start(action, in: &session))
        }
        let events = session.run([action])
        XCTAssertEqual(
            events.last?.payload.objectFields?["error"]?.objectFields?["message"],
            .string("Too many platform calls in flight")
        )
        XCTAssertTrue(session.takePlatformCommands().isEmpty)
        _ = session.completePlatformCall(ids[0], .success(.null), durationMs: 0)
        let fifth = try start(action, in: &session)
        _ = session.completePlatformCall(fifth, .success(.null), durationMs: 0)
        let refused = session.run([action])
        XCTAssertEqual(
            refused.last?.payload.objectFields?["error"]?.objectFields?["message"],
            .string("Rate limit exceeded for share: at most 5 calls per 10000 ms")
        )
        XCTAssertTrue(session.takePlatformCommands().isEmpty)
    }

    func testSessionResolvedArgumentFailuresDoNotConsumeShareBudget() throws {
        let clock = RateLimitClock()
        var session = try session(clock: clock)
        let invalid = try JSONDecoder().decode(PrototypeAction.self, from: Data("""
        {"type":"platform","call":"share.open","statusKey":"status",
         "into":"/data/share","args":{"text":{"value":42}},
         "onError":[{"type":"emit","name":"invalid"}]}
        """.utf8))
        for _ in 0 ..< 5 {
            let events = session.run([invalid])
            let payload = try XCTUnwrap(events.first { $0.name == "prototype_platform" }?.payload.objectFields)
            XCTAssertEqual(payload["error"], .object([
                "code": .string(PlatformErrorCode.invalidArgs.rawValue),
                "message": .string("Invalid argument: text"),
            ]))
            XCTAssertEqual(session.state["status"], .string("error"))
            XCTAssertEqual(events.last?.name, "invalid")
            XCTAssertTrue(session.takePlatformCommands().isEmpty)
            let id = try XCTUnwrap(payload["callId"]?.stringValue)
            XCTAssertTrue(session.completePlatformCall(id, .success(.null), durationMs: 0).isEmpty)
        }
        // The fake clock stays within the same window for the corrected calls.
        let action = try shareAction()
        for _ in 0 ..< 5 {
            let id = try start(action, in: &session)
            XCTAssertEqual(session.state["status"], .string("loading"))
            _ = session.completePlatformCall(id, .success(.null), durationMs: 0)
        }
        let events = session.run([action])
        let payload = try XCTUnwrap(events.first { $0.name == "prototype_platform" }?.payload.objectFields)
        XCTAssertEqual(payload["error"], .object([
            "code": .string(PlatformErrorCode.tooManyInFlight.rawValue),
            "message": .string("Rate limit exceeded for share: at most 5 calls per 10000 ms"),
        ]))
        XCTAssertTrue(session.takePlatformCommands().isEmpty)
        let invalidEvents = session.run([invalid])
        let invalidPayload = try XCTUnwrap(
            invalidEvents.first { $0.name == "prototype_platform" }?.payload
                .objectFields
        )
        XCTAssertEqual(
            invalidPayload["error"]?.objectFields?["code"],
            .string(PlatformErrorCode.invalidArgs.rawValue)
        )
        XCTAssertTrue(session.takePlatformCommands().isEmpty)
    }

    func testSessionArgumentFailuresPrecedeRateLimitAndDoNotConsumeBudget() throws {
        var session = try session(clock: RateLimitClock())
        let invalid = try JSONDecoder().decode(PrototypeAction.self, from: Data("""
        {"type":"platform","call":"share.open","args":{"text":{"data":"/missing"}}}
        """.utf8))
        for _ in 0 ..< 3 {
            let events = session.run([invalid])
            XCTAssertEqual(
                events.last?.payload.objectFields?["error"]?.objectFields?["code"],
                .string(PlatformErrorCode.invalidArgs.rawValue)
            )
            XCTAssertTrue(session.takePlatformCommands().isEmpty)
        }
        let action = try shareAction()
        for _ in 0 ..< 5 {
            let id = try start(action, in: &session)
            _ = session.completePlatformCall(id, .success(.null), durationMs: 0)
        }
        let events = session.run([invalid])
        XCTAssertEqual(
            events.last?.payload.objectFields?["error"]?.objectFields?["code"],
            .string(PlatformErrorCode.invalidArgs.rawValue)
        )
        XCTAssertTrue(session.takePlatformCommands().isEmpty)
    }
}
