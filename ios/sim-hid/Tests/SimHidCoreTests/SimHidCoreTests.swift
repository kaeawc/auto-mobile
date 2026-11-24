@testable import SimHidCore
import XCTest

private final class FakeSender: SimHidSender {
    var sent: [SimHidStep] = []
    var slept: [Double] = []
    var failAfter: Int?
    var notSentAfter: Int?
    /// Fails only the attempt with this zero-based index; later sends succeed.
    var failAttempt: Int?
    var notSentAttempt: Int?
    private(set) var attempts: [SimHidStep] = []
    private var clock = 0.0

    func send(_ step: SimHidStep) throws {
        let attempt = attempts.count
        attempts.append(step)
        if attempt == notSentAttempt { throw SimHidNotSent(SimHidError("send-failed", "no message")) }
        if attempt == failAttempt { throw SimHidError("send-failed", "boom") }
        if let notSentAfter, sent.count >= notSentAfter {
            throw SimHidNotSent(SimHidError("send-failed", "no message"))
        }
        if let failAfter, sent.count >= failAfter { throw SimHidError("send-failed", "boom") }
        sent.append(step)
    }

    func sleep(milliseconds: Double) {
        slept.append(milliseconds)
        clock += milliseconds
    }

    func nowMs() -> Double {
        clock
    }
}

final class SimHidRequestParserTests: XCTestCase {
    func testParsesTapWithScreen() throws {
        let request = try SimHidRequestParser.parse(#"{"id":"7","cmd":"tap","x":201,"y":437,"width":402,"height":874}"#)
        XCTAssertEqual(request.id, "7")
        XCTAssertEqual(
            request.command,
            .tap(point: SimHidPoint(x: 201, y: 437), holdMs: 0, screen: SimHidScreen(width: 402, height: 874))
        )
    }

    func testParsesSwipeKeyButtonAndType() throws {
        XCTAssertEqual(
            try SimHidRequestParser.parse(
                #"{"id":"1","cmd":"swipe","x":1,"y":2,"toX":3,"toY":4,"durationMs":100,"width":10,"height":20}"#
            ).command,
            .swipe(
                from: SimHidPoint(x: 1, y: 2), to: SimHidPoint(x: 3, y: 4), durationMs: 100,
                screen: SimHidScreen(width: 10, height: 20)
            )
        )
        XCTAssertEqual(
            try SimHidRequestParser.parse(#"{"id":"2","cmd":"key","key":"h","modifiers":["meta"]}"#).command,
            .key(name: "h", modifiers: ["meta"])
        )
        XCTAssertEqual(
            try SimHidRequestParser.parse(#"{"id":"3","cmd":"button","button":"lock"}"#).command,
            .button(.lock, holdMs: 0)
        )
        XCTAssertEqual(
            try SimHidRequestParser.parse(#"{"id":"4","cmd":"type","text":"Hi"}"#).command,
            .type(text: "Hi")
        )
    }

    func testRejectsMalformedCommands() {
        let cases = [
            "not json",
            #"{"cmd":"ping"}"#,
            #"{"id":"1"}"#,
            #"{"id":"1","cmd":"tap","x":1,"y":2}"#,
            #"{"id":"1","cmd":"tap","x":1,"y":2,"width":0,"height":5}"#,
            #"{"id":"1","cmd":"tap","x":1,"y":2,"width":5,"height":5,"holdMs":20000}"#,
            #"{"id":"1","cmd":"button","button":"volume"}"#,
            #"{"id":"1","cmd":"warp"}"#,
        ]
        for line in cases {
            XCTAssertThrowsError(try SimHidRequestParser.parse(line), line) { error in
                XCTAssertEqual((error as? SimHidError)?.code, "invalid-command", line)
            }
        }
    }
}

final class SimHidPlannerTests: XCTestCase {
    private let screen = SimHidScreen(width: 400, height: 800)

    func testTapNormalizesAndHolds() throws {
        let steps = try SimHidPlanner.steps(for: .tap(point: SimHidPoint(x: 100, y: 200), holdMs: 50, screen: screen))
        let point = SimHidPoint(x: 0.25, y: 0.25)
        XCTAssertEqual(steps, [
            .touch(point, second: nil, phase: .down),
            .wait(ms: 50),
            .touch(point, second: nil, phase: .up),
        ])
    }

    func testNormalizeClampsToTheScreen() {
        XCTAssertEqual(
            SimHidPlanner.normalize(SimHidPoint(x: -5, y: 900), screen),
            SimHidPoint(x: 0, y: 1)
        )
    }

    func testSwipePacesDragsAboveTheCoalescingInterval() throws {
        let steps = try SimHidPlanner.steps(for: .swipe(
            from: SimHidPoint(x: 0, y: 0), to: SimHidPoint(x: 400, y: 800), durationMs: 68, screen: screen
        ))
        let waits = steps.compactMap { step -> Double? in
            if case let .wait(ms) = step { return ms }
            return nil
        }
        XCTAssertEqual(waits, [17, 17, 17, 17])
        XCTAssertEqual(steps.first, .touch(SimHidPoint(x: 0, y: 0), second: nil, phase: .down))
        XCTAssertEqual(steps.last, .touch(SimHidPoint(x: 1, y: 1), second: nil, phase: .up))
        XCTAssertEqual(steps[steps.count - 2], .touch(SimHidPoint(x: 1, y: 1), second: nil, phase: .dragged))
    }

    func testPinchMovesTwoFingers() throws {
        let steps = try SimHidPlanner.steps(for: .pinch(
            center: SimHidPoint(x: 200, y: 400), startRadius: 0, endRadius: 100, durationMs: 0, screen: screen
        ))
        XCTAssertEqual(
            steps.first,
            .touch(SimHidPoint(x: 0.5, y: 0.5), second: SimHidPoint(x: 0.5, y: 0.5), phase: .down)
        )
        XCTAssertEqual(
            steps.last,
            .touch(SimHidPoint(x: 0.25, y: 0.5), second: SimHidPoint(x: 0.75, y: 0.5), phase: .up)
        )
    }

    func testKeyChordHoldsModifiersAroundTheKey() throws {
        XCTAssertEqual(try SimHidPlanner.steps(for: .key(name: "h", modifiers: ["meta", "shift", "meta"])), [
            .key(usage: 0xE3, down: true),
            .key(usage: 0xE1, down: true),
            .key(usage: 0x0B, down: true),
            .key(usage: 0x0B, down: false),
            .key(usage: 0xE1, down: false),
            .key(usage: 0xE3, down: false),
        ])
        XCTAssertEqual(try SimHidPlanner.steps(for: .key(name: "enter", modifiers: [])), [
            .key(usage: 0x28, down: true),
            .key(usage: 0x28, down: false),
        ])
    }

    func testUnsupportedKeysAndCharactersThrowBeforeAnyStep() {
        XCTAssertThrowsError(try SimHidPlanner.steps(for: .key(name: "search", modifiers: [])))
        XCTAssertThrowsError(try SimHidPlanner.steps(for: .key(name: "a", modifiers: ["hyper"])))
        XCTAssertThrowsError(try SimHidPlanner.steps(for: .type(text: "ok é"))) { error in
            XCTAssertEqual((error as? SimHidError)?.code, "unsupported-character")
        }
    }

    func testTypingShiftsUppercaseAndSymbols() throws {
        XCTAssertEqual(try SimHidPlanner.steps(for: .type(text: "A0?")), [
            .key(usage: 0xE1, down: true), .key(usage: 0x04, down: true), .key(usage: 0x04, down: false),
            .key(usage: 0xE1, down: false),
            .key(usage: 0x27, down: true), .key(usage: 0x27, down: false),
            .key(usage: 0xE1, down: true), .key(usage: 0x38, down: true), .key(usage: 0x38, down: false),
            .key(usage: 0xE1, down: false),
        ])
    }

    func testButtonsUseTheirIndigoSources() throws {
        XCTAssertEqual(try SimHidPlanner.steps(for: .button(.home, holdMs: 0)), [
            .button(source: 0x0, down: true), .button(source: 0x0, down: false),
        ])
        XCTAssertEqual(try SimHidPlanner.steps(for: .button(.lock, holdMs: 0)).first, .button(source: 0x1, down: true))
    }
}

final class SimHidServerTests: XCTestCase {
    func testDeliveredCommandAcksWithElapsedTime() {
        let sender = FakeSender()
        let ack = SimHidServer(sender: sender).handle(
            line: #"{"id":"9","cmd":"tap","x":1,"y":1,"holdMs":30,"width":2,"height":2}"#
        )
        XCTAssertEqual(ack, SimHidAck(id: "9", ok: true, sent: true, elapsedMs: 30))
        XCTAssertEqual(sender.sent.count, 2)
        XCTAssertEqual(sender.slept, [30])
    }

    func testInvalidCommandSendsNothing() {
        let sender = FakeSender()
        let ack = SimHidServer(sender: sender).handle(line: #"{"id":"3","cmd":"type","text":"é"}"#)
        XCTAssertEqual(ack.id, "3")
        XCTAssertFalse(ack.ok)
        XCTAssertFalse(ack.sent)
        XCTAssertEqual(ack.error?.code, "unsupported-character")
        XCTAssertTrue(sender.sent.isEmpty)
    }

    func testFailureAfterTheFirstMessageReportsSent() {
        let sender = FakeSender()
        sender.failAfter = 1
        let ack = SimHidServer(sender: sender).handle(line: #"{"id":"4","cmd":"button","button":"home"}"#)
        XCTAssertFalse(ack.ok)
        XCTAssertTrue(ack.sent)
        XCTAssertEqual(ack.error?.code, "send-failed")
    }

    func testFailureAfterHandOffOfTheFirstMessageReportsSent() {
        // A completion error or timeout follows the hand-off to SimulatorKit, so the message may
        // have landed: the ack must say sent so the caller never replays it elsewhere.
        let sender = FakeSender()
        sender.failAfter = 0
        let ack = SimHidServer(sender: sender).handle(line: #"{"id":"5","cmd":"key","key":"tab"}"#)
        XCTAssertFalse(ack.ok)
        XCTAssertTrue(ack.sent)
        XCTAssertEqual(ack.error?.code, "send-failed")
    }

    func testNoMessageBuiltOnTheFirstStepReportsNotSent() {
        let sender = FakeSender()
        sender.notSentAfter = 0
        let ack = SimHidServer(sender: sender).handle(line: #"{"id":"6","cmd":"key","key":"tab"}"#)
        XCTAssertFalse(ack.ok)
        XCTAssertFalse(ack.sent)
        XCTAssertEqual(ack.error?.message, "no message")
    }

    func testNoMessageBuiltAfterAnEarlierStepReportsSent() {
        let sender = FakeSender()
        sender.notSentAfter = 1
        let ack = SimHidServer(sender: sender).handle(line: #"{"id":"7","cmd":"button","button":"home"}"#)
        XCTAssertTrue(ack.sent)
    }

    func testFailedTypingReleasesShiftBeforeAcking() {
        // "A" is shift-down, a-down, a-up, shift-up; the a-down send fails after hand-off, so
        // the a key may be down too.
        let sender = FakeSender()
        sender.failAttempt = 1
        let ack = SimHidServer(sender: sender).handle(line: #"{"id":"8","cmd":"type","text":"A"}"#)
        XCTAssertFalse(ack.ok)
        XCTAssertTrue(ack.sent)
        let shift = SimHidKeyboard.leftShift
        let aUsage = SimHidKeyboard.usage(for: "a")?.usage ?? 0
        XCTAssertEqual(Array(sender.attempts.dropFirst(2)), [
            .key(usage: aUsage, down: false), .key(usage: shift, down: false),
        ])
    }

    func testFailedSwipeLiftsTheFingerAtTheLastPoint() {
        let sender = FakeSender()
        sender.failAttempt = 2
        let ack = SimHidServer(sender: sender).handle(
            line: #"{"id":"9","cmd":"swipe","x":0,"y":0,"toX":10,"toY":0,"durationMs":34,"width":10,"height":10}"#
        )
        XCTAssertFalse(ack.ok)
        guard case let .touch(failedPoint, _, .dragged) = sender.attempts[2] else {
            return XCTFail("expected the failed step to be a drag")
        }
        XCTAssertEqual(sender.attempts.last, .touch(failedPoint, second: nil, phase: .up))
        XCTAssertEqual(sender.attempts.count, 4)
    }

    func testNoMessageMidSwipeStillSendsTouchUp() {
        let sender = FakeSender()
        sender.notSentAttempt = 2
        let ack = SimHidServer(sender: sender).handle(
            line: #"{"id":"12","cmd":"swipe","x":0,"y":0,"toX":10,"toY":0,"durationMs":34,"width":10,"height":10}"#
        )
        XCTAssertFalse(ack.ok)
        XCTAssertTrue(ack.sent)
        guard let last = sender.attempts.last, case let .touch(_, _, phase) = last else {
            return XCTFail("expected a touch release")
        }
        XCTAssertEqual(phase, .up)
    }

    func testFailedButtonReleasesTheButton() {
        let sender = FakeSender()
        sender.notSentAttempt = 1
        let ack = SimHidServer(sender: sender).handle(line: #"{"id":"10","cmd":"button","button":"home"}"#)
        XCTAssertTrue(ack.sent)
        XCTAssertEqual(sender.attempts.last, .button(source: 0x0, down: false))
        XCTAssertEqual(sender.attempts.count, 3)
    }

    func testFailedFirstStepThatMayHaveLandedIsReleased() {
        let sender = FakeSender()
        sender.failAttempt = 0
        _ = SimHidServer(sender: sender).handle(line: #"{"id":"11","cmd":"button","button":"lock"}"#)
        XCTAssertEqual(sender.attempts, [.button(source: 0x1, down: true), .button(source: 0x1, down: false)])
    }

    func testCompletedCommandSendsNoExtraRelease() {
        let sender = FakeSender()
        _ = SimHidServer(sender: sender).handle(line: #"{"id":"12","cmd":"key","key":"tab","modifiers":["shift"]}"#)
        XCTAssertEqual(sender.attempts.count, 4)
    }

    func testEncodesAcksAndReadyAsSortedJSON() {
        XCTAssertEqual(
            SimHidServer.encode(SimHidAck(id: "1", ok: true, sent: true, elapsedMs: 0.5)),
            #"{"elapsedMs":0.5,"id":"1","ok":true,"sent":true}"#
        )
        XCTAssertEqual(SimHidServer.encode(SimHidReady(initMs: 12.34)), #"{"event":"ready","initMs":12.3}"#)
    }
}
