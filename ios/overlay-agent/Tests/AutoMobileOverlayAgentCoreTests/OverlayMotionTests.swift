@testable import AutoMobileOverlayAgentCore
import XCTest

private final class FakeTimer: OverlayTimerHandle {
    let delay: Int
    let fire: () -> Void
    private(set) var cancelled = false
    init(delay: Int, fire: @escaping () -> Void) {
        self.delay = delay
        self.fire = fire
    }

    func cancel() { cancelled = true }
}

private final class FakeClock: OverlayClock {
    private(set) var timers: [FakeTimer] = []

    func schedule(afterMilliseconds: Int, _ fire: @escaping () -> Void) -> OverlayTimerHandle {
        let timer = FakeTimer(delay: afterMilliseconds, fire: fire)
        timers.append(timer)
        return timer
    }

    /// Runs every live timer, as if its delay elapsed.
    func advance() {
        timers.filter { !$0.cancelled }.forEach { $0.fire() }
    }

    var live: [FakeTimer] { timers.filter { !$0.cancelled } }
}

final class OverlayMotionTests: XCTestCase {
    private func spec(_ json: String) throws -> OverlaySpec {
        try JSONDecoder().decode(OverlaySpec.self, from: Data(json.utf8))
    }

    // MARK: Motion decision

    func testMotionIsOnByDefault() {
        XCTAssertTrue(OverlayMotion(specMotion: nil, reduceMotion: false).enabled)
        XCTAssertTrue(OverlayMotion(specMotion: "standard", reduceMotion: false).enabled)
    }

    func testSpecMotionNoneOrReduceMotionTurnsItOff() {
        XCTAssertFalse(OverlayMotion(specMotion: "none", reduceMotion: false).enabled)
        XCTAssertFalse(OverlayMotion(specMotion: nil, reduceMotion: true).enabled)
        XCTAssertFalse(OverlayMotion(specMotion: "standard", reduceMotion: true).enabled)
    }

    func testNodeTransitionPicksTheVisibilityAnimation() {
        let motion = OverlayMotion(specMotion: nil, reduceMotion: false)
        XCTAssertEqual(motion.visibility(transition: nil), .standard)
        XCTAssertEqual(motion.visibility(transition: "none"), .instant)
        XCTAssertEqual(motion.visibility(transition: "fade"), .fade)
        XCTAssertEqual(motion.visibility(transition: "expand"), .expand)
        XCTAssertEqual(motion.visibility(transition: "slide"), .slide)
    }

    func testDisabledMotionIsInstantWhateverTheTransition() {
        let off = OverlayMotion(specMotion: "none", reduceMotion: false)
        XCTAssertEqual(["fade", "expand", "slide", nil].map { off.visibility(transition: $0) },
                       Array(repeating: .instant, count: 4))
    }

    func testSpecDecodesMotionTransitionAndDuration() throws {
        let decoded = try spec("""
        {"id":"a","window":{"placement":{"type":"fullscreen"}},"motion":"none",
         "root":{"type":"snackbar","openWhen":{"key":"s","equals":true},"text":"x","durationMs":3000,
                 "transition":"slide"}}
        """)
        XCTAssertEqual(decoded.motion, "none")
        XCTAssertEqual(decoded.root.durationMs, 3000)
        XCTAssertEqual(decoded.root.transition, "slide")
    }

    // MARK: Snackbar timeout

    private func snackbar(durationMs: Int?, open: Bool = true) throws -> (OverlaySession, OverlayNode) {
        let duration = durationMs.map { #","durationMs":\#($0)"# } ?? ""
        var session = OverlaySession()
        try session.show(spec("""
        {"id":"a","window":{"placement":{"type":"fullscreen"}},"state":{"s":\(open)},
         "root":{"type":"snackbar","openWhen":{"key":"s","equals":true},"text":"Saved"\(duration)}}
        """))
        let node = try XCTUnwrap(session.spec?.root)
        return (session, node)
    }

    func testTimerClosesTheSnackbarThroughItsOpenKey() throws {
        var (session, node) = try snackbar(durationMs: 2500)
        let clock = FakeClock()
        let timeouts = SnackbarTimeouts(clock: clock) { _ = session.closeModal($0) }
        timeouts.sync(openModals: session.spec!.root.openModals(state: session.state, pages: session.pages))
        XCTAssertEqual(clock.live.map(\.delay), [2500])
        XCTAssertEqual(session.state["s"], .bool(true))
        clock.advance()
        XCTAssertEqual(session.state["s"], .bool(false))
        XCTAssertEqual(timeouts.pendingCount, 0)
        XCTAssertEqual(node.durationMs, 2500)
    }

    func testSnackbarWithoutDurationSchedulesNothing() throws {
        let (session, _) = try snackbar(durationMs: nil)
        let clock = FakeClock()
        let timeouts = SnackbarTimeouts(clock: clock) { _ in }
        timeouts.sync(openModals: session.spec!.root.openModals(state: session.state, pages: session.pages))
        XCTAssertTrue(clock.timers.isEmpty)
    }

    func testClosingBeforeTheTimeoutCancelsIt() throws {
        let (session, _) = try snackbar(durationMs: 5000)
        let clock = FakeClock()
        var closed = 0
        let timeouts = SnackbarTimeouts(clock: clock) { _ in closed += 1 }
        let root = session.spec!.root
        timeouts.sync(openModals: root.openModals(state: session.state, pages: session.pages))
        timeouts.sync(openModals: root.openModals(state: ["s": .bool(false)], pages: [:]))
        XCTAssertEqual(clock.timers.map(\.cancelled), [true])
        clock.advance()
        XCTAssertEqual(closed, 0)
    }

    func testResyncingTheSameOpenSnackbarKeepsItsRunningTimer() throws {
        let (session, _) = try snackbar(durationMs: 5000)
        let clock = FakeClock()
        let timeouts = SnackbarTimeouts(clock: clock) { _ in }
        let open = session.spec!.root.openModals(state: session.state, pages: session.pages)
        timeouts.sync(openModals: open)
        timeouts.sync(openModals: open)
        XCTAssertEqual(clock.timers.count, 1)
    }

    func testReopeningAfterCloseStartsAFreshTimer() throws {
        let (session, _) = try snackbar(durationMs: 5000)
        let clock = FakeClock()
        let timeouts = SnackbarTimeouts(clock: clock) { _ in }
        let root = session.spec!.root
        timeouts.sync(openModals: root.openModals(state: ["s": .bool(true)], pages: [:]))
        timeouts.sync(openModals: [])
        timeouts.sync(openModals: root.openModals(state: ["s": .bool(true)], pages: [:]))
        XCTAssertEqual(clock.timers.map(\.cancelled), [true, false])
    }
}
