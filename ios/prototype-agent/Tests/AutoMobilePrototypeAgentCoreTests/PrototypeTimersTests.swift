@testable import AutoMobilePrototypeAgentCore
import XCTest

private final class TimerTestHandle: PrototypeTimerHandle {
    let due: Int
    let fire: () -> Void
    var cancelled = false
    init(due: Int, fire: @escaping () -> Void) {
        self.due = due
        self.fire = fire
    }

    func cancel() { cancelled = true }
}

private final class TimerTestClock: PrototypeClock {
    var nowMilliseconds = 0
    var handles: [TimerTestHandle] = []
    func schedule(afterMilliseconds: Int, _ fire: @escaping () -> Void) -> PrototypeTimerHandle {
        let handle = TimerTestHandle(due: nowMilliseconds + afterMilliseconds, fire: fire)
        handles.append(handle)
        return handle
    }

    func elapse(_ milliseconds: Int) {
        nowMilliseconds += milliseconds
        while let handle = handles.first(where: { !$0.cancelled && $0.due <= nowMilliseconds }) {
            handle.cancel()
            handle.fire()
        }
    }
}

/// Same ordering and non-activity path as PrototypeModel, without UIKit.
private final class TimerTestHarness {
    let clock = TimerTestClock()
    var session = PrototypeSession()
    var events: [PrototypeEvent] = []
    lazy var timers = PrototypeTimers(clock: clock) { [weak self] in self?.apply($0, activity: false) }
    lazy var idle = PrototypeIdleTimer(clock: clock, ttlMilliseconds: 1000) { [weak self] in
        guard let self else { return }
        events += session.dismiss(reason: .ttl)
        timers.perform(session.takeTimerCommands())
    }

    func show() throws {
        let spec = try JSONDecoder().decode(PrototypeSpec.self, from: Data("""
        {"id":"test","state":{"n":0,"flag":false},"window":{"placement":{"type":"fullscreen"}},
        "root":{"type":"column","children":[{"type":"text","text":"hi"},
        {"type":"switch","stateKey":"flag"}]}}
        """.utf8))
        session.show(spec)
        timers.perform(session.takeTimerCommands())
        idle.arm()
    }

    func apply(_ actions: [PrototypeAction], activity: Bool = true) {
        events += session.transition { $0.run(actions) }
        timers.perform(session.takeTimerCommands())
        if session.isShown {
            if activity { idle.arm() }
        } else { idle.cancel() }
    }
}

final class PrototypeTimersTests: XCTestCase {
    private func action(_ json: String) throws -> PrototypeAction {
        try JSONDecoder().decode(PrototypeAction.self, from: Data(json.utf8))
    }

    private func start(
        _ id: String = "a",
        after: Int = 100,
        extra: String = "",
        actions: String = ""
    )
        throws -> PrototypeAction
    {
        try action("""
        {"type":"startTimer","id":"\(id)","afterMs":\(after)\(extra),"actions":[\(actions)]}
        """)
    }

    func testOrderingPlannedPeriodMaxRunsAndSnapshot() throws {
        let clock = TimerTestClock()
        var names: [String] = []
        let timers = PrototypeTimers(clock: clock) { names += $0.compactMap(\.name) }
        try timers.perform([
            .start(start("later", after: 200, actions: #"{"type":"emit","name":"later"}"#)),
            .start(start(
                "first",
                extra: #", "everyMs":100,"maxRuns":3"#,
                actions: #"{"type":"emit","name":"first"}"#
            )),
            .start(start("second", actions: #"{"type":"emit","name":"second"}"#)),
        ])
        XCTAssertEqual(timers.snapshot().map(\.id), ["first", "second", "later"])
        XCTAssertEqual(timers.advance(200), .init(fired: 4, error: nil))
        XCTAssertEqual(names, ["first", "second", "later", "first"])
        XCTAssertEqual(timers.snapshot(), [.init(id: "first", nextFireInMs: 100, runs: 2)])
        XCTAssertEqual(timers.advance(100).fired, 1)
        XCTAssertEqual(timers.snapshot(), [])
    }

    func testReplaceCancelAndDefensiveLimit() throws {
        let timers = PrototypeTimers(clock: TimerTestClock()) { _ in }
        for index in 0 ..< 9 {
            try timers.perform([.start(start("\(index)"))])
        }
        XCTAssertEqual(timers.snapshot().count, 8)
        try timers.perform([.start(start("0", after: 300)), .cancel("1"), .cancel("unknown")])
        XCTAssertEqual(timers.snapshot().last, .init(id: "0", nextFireInMs: 300, runs: 0))
        timers.cancelAll()
        XCTAssertEqual(timers.snapshot(), [])
    }

    func testSelfCancelAndSameIdReplacementNewTimerWins() throws {
        let harness = TimerTestHarness()
        try harness.show()
        try harness.apply([start(extra: #", "everyMs":100"#, actions: #"{"type":"cancelTimer","id":"a"}"#)])
        XCTAssertEqual(harness.timers.advance(500).fired, 1)
        XCTAssertTrue(harness.timers.snapshot().isEmpty)
        try harness
            .apply(
                [
                    start(
                        actions: #"{"type":"startTimer","id":"a","afterMs":200,"actions":[{"type":"increment","key":"n"}]}"#
                    ),
                ]
            )
        XCTAssertEqual(harness.timers.advance(100).fired, 1)
        XCTAssertEqual(harness.timers.snapshot(), [.init(id: "a", nextFireInMs: 200, runs: 0)])
        XCTAssertEqual(harness.timers.advance(200).fired, 1)
        XCTAssertEqual(harness.session.state["n"], .number(1))
    }

    func testNestedStartWithinAdvanceWindowAndSingleChange() throws {
        let harness = TimerTestHarness()
        try harness.show()
        try harness
            .apply(
                [
                    start(
                        actions: #"{"type":"startTimer","id":"b","afterMs":100,"actions":[{"type":"increment","key":"n"},{"type":"increment","key":"n"}]}"#
                    ),
                ]
            )
        XCTAssertEqual(harness.timers.advance(200).fired, 2)
        XCTAssertEqual(harness.session.state["n"], .number(2))
        XCTAssertEqual(harness.events.filter(\.isStateChange).count, 1)
    }

    func testAtomicRejectionCountsRunWithoutEventsOrCommands() throws {
        let harness = TimerTestHarness()
        try harness.show()
        try harness.apply([start(
            extra: #", "everyMs":100,"maxRuns":2"#,
            actions: #"{"type":"emit","name":"no"},{"type":"setState","key":"flag","value":"invalid"},{"type":"cancelTimer","id":"a"}"#
        )])
        XCTAssertEqual(harness.timers.advance(100).fired, 1)
        XCTAssertEqual(harness.timers.snapshot().first?.runs, 1)
        XCTAssertEqual(harness.session.state["flag"], .bool(false))
        XCTAssertTrue(harness.events.isEmpty)
        XCTAssertEqual(harness.timers.advance(100).fired, 1)
        XCTAssertTrue(harness.timers.snapshot().isEmpty)
    }

    func testDismissStopsRemainingActionsAndCancelsAllAndShowReplaces() throws {
        let harness = TimerTestHarness()
        try harness.show()
        try harness.apply([start(actions: #"{"type":"dismiss"},{"type":"increment","key":"n"}"#), start("b")])
        XCTAssertEqual(harness.timers.advance(100).fired, 1)
        XCTAssertFalse(harness.session.isShown)
        XCTAssertTrue(harness.timers.snapshot().isEmpty)
        try harness.show()
        try harness.apply([start()])
        try harness.show()
        XCTAssertTrue(harness.timers.snapshot().isEmpty)
    }

    func testPauseFreezesRemainingTimeAndRealSchedulingContinuesAfterAdvance() throws {
        let clock = TimerTestClock()
        var fires = 0
        let timers = PrototypeTimers(clock: clock) { _ in fires += 1 }
        try timers.perform([.start(start(after: 300))])
        clock.elapse(100)
        timers.pause()
        clock.elapse(1000)
        XCTAssertEqual(timers.snapshot().first?.nextFireInMs, 200)
        XCTAssertEqual(timers.advance(1000).fired, 0)
        timers.resume()
        XCTAssertEqual(timers.advance(100).fired, 0)
        clock.elapse(100)
        XCTAssertEqual(fires, 1)
        XCTAssertTrue(timers.snapshot().isEmpty)
    }

    func testAdvanceCapRetainsPendingWork() throws {
        let timers = PrototypeTimers(clock: TimerTestClock()) { _ in }
        try timers.perform([.start(start(extra: #", "everyMs":100"#))])
        let result = timers.advance(1_000_100)
        XCTAssertEqual(result.fired, 10000)
        XCTAssertNotNil(result.error)
        XCTAssertEqual(timers.snapshot().first?.runs, 10000)
        XCTAssertEqual(timers.advance(100).fired, 1)
    }

    func testExactAdvanceCapReportsLimitEvenWhenLastTimerCompletes() throws {
        let timers = PrototypeTimers(clock: TimerTestClock()) { _ in }
        try timers.perform([.start(start(extra: #", "everyMs":100,"maxRuns":10000"#))])
        let result = timers.advance(1_000_000)
        XCTAssertEqual(result.fired, 10000)
        XCTAssertNotNil(result.error)
        XCTAssertTrue(timers.snapshot().isEmpty)
    }

    func testTimerFiresNeverRestartIdleTTL() throws {
        let harness = TimerTestHarness()
        try harness.show()
        try harness.apply([start(extra: #", "everyMs":100"#, actions: #"{"type":"increment","key":"n"}"#)])
        harness.clock.elapse(900)
        XCTAssertEqual(harness.session.state["n"], .number(9))
        harness.clock.elapse(100)
        XCTAssertFalse(harness.session.isShown)
        XCTAssertTrue(harness.timers.snapshot().isEmpty)
    }

    func testRequireValidGuardAndPatchLeaveTimerScheduleIntact() throws {
        let harness = TimerTestHarness()
        try harness.show()
        try harness.apply([start(
            extra: #", "everyMs":100,"maxRuns":2"#,
            actions: #"{"type":"emit","name":"guarded","requireValid":["missing"]},{"type":"increment","key":"n"}"#
        )])
        let before = harness.timers.snapshot()
        let ops = try JSONDecoder().decode(
            JSONValue.self,
            from: Data(#"[{"op":"replace","path":"/state/n","value":5}]"#.utf8)
        )
        let (outcome, _) = harness.session.patch(id: "test", baseRevision: harness.session.dataRevision, ops: ops)
        XCTAssertTrue(outcome.reply.success)
        harness.timers.perform(harness.session.takeTimerCommands())
        XCTAssertEqual(harness.timers.snapshot(), before)
        XCTAssertEqual(harness.timers.advance(100).fired, 1)
        XCTAssertEqual(harness.session.state["n"], .number(5))
        XCTAssertEqual(harness.events.map(\.wireKind), ["validation_failed"])
        XCTAssertEqual(harness.timers.snapshot().first?.runs, 1)
    }

    func testAllDismissReasonsCancelTimers() throws {
        for reason: PrototypeSessionDismissReason in [.user, .agent, .disconnect, .ttl] {
            let harness = TimerTestHarness()
            try harness.show()
            try harness.apply([start()])
            _ = harness.session.dismiss(reason: reason)
            harness.timers.perform(harness.session.takeTimerCommands())
            XCTAssertTrue(harness.timers.snapshot().isEmpty)
        }
    }

    func testTimerIdsStayLiteralWhileNestedActionsBindRepeatFields() throws {
        let raw = try JSONDecoder().decode(
            JSONValue.self,
            from: Data(
                #"{"type":"startTimer","id":"{row.id}","afterMs":100,"actions":[{"type":"setState","key":"value_{index}","value":"{row.name}"},{"type":"cancelTimer","id":"{row.id}"}]}"#
                    .utf8
            )
        )
        let bound = PrototypeRepeatInstance(alias: "row", item: ["name": .string("Ada")], index: 2).bindAction(raw)
        let decoded = try JSONDecoder().decode(PrototypeAction.self, from: JSONEncoder().encode(bound))
        XCTAssertEqual(decoded.id, "{row.id}")
        XCTAssertEqual(decoded.actions?.first?.key, "value_2")
        XCTAssertEqual(decoded.actions?.first?.value, .string("Ada"))
        XCTAssertEqual(decoded.actions?.last?.id, "{row.id}")
        XCTAssertEqual(decoded.flattened.count, 3)
    }

    func testDistinctIdLimitAndEmptyCancelId() throws {
        let actions = (0 ..< 9).map { index in
            PrototypeLocatedValue(
                value: ["type": .string("startTimer"), "id": .string("id\(index)")],
                path: "root.onTap[\(index)]"
            )
        }
        XCTAssertThrowsError(try PrototypeTimerValidator.validate(actions)) {
            XCTAssertEqual(
                $0 as? PrototypeLoadError,
                .invalidSpec(path: "root.onTap[8].id", message: "Too many distinct timer ids")
            )
        }
        XCTAssertNoThrow(try PrototypeTimerValidator.validate(Array(repeating: actions[0], count: 20)))
        XCTAssertThrowsError(try PrototypeTimerValidator.validate([
            .init(value: ["type": .string("cancelTimer"), "id": .string("")], path: "root.onTap[0]"),
        ]))
    }

    func testCapabilityAndValidatorRules() throws {
        XCTAssertTrue(PrototypeAgentProtocol.capabilities.contains("prototype_timers_v1"))
        XCTAssertTrue(PrototypeAgentProtocol.capabilities.contains("advance_prototype_clock"))
        let invalid: [String: JSONValue] = ["type": .string("startTimer"), "id": .string("x"), "maxRuns": .number(1)]
        XCTAssertThrowsError(try PrototypeTimerValidator.validate([.init(value: invalid, path: "root.onTap[0]")])) {
            XCTAssertEqual(
                $0 as? PrototypeLoadError,
                .invalidSpec(path: "root.onTap[0].maxRuns", message: "maxRuns requires everyMs")
            )
        }
    }
}
