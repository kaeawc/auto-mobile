@testable import AutoMobilePrototypeAgentCore
import XCTest

private final class FakeTimer: PrototypeTimerHandle {
    let delay: Int
    let fire: () -> Void
    private(set) var cancelled = false
    init(delay: Int, fire: @escaping () -> Void) {
        self.delay = delay
        self.fire = fire
    }

    func cancel() { cancelled = true }
}

private final class FakeClock: PrototypeClock {
    private(set) var timers: [FakeTimer] = []

    func schedule(afterMilliseconds: Int, _ fire: @escaping () -> Void) -> PrototypeTimerHandle {
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

final class PrototypeMotionTests: XCTestCase {
    private func spec(_ json: String) throws -> PrototypeSpec {
        try JSONDecoder().decode(PrototypeSpec.self, from: Data(json.utf8))
    }

    // MARK: Motion decision

    func testMotionIsOnByDefault() {
        XCTAssertTrue(PrototypeMotion(specMotion: nil, reduceMotion: false).enabled)
        XCTAssertTrue(PrototypeMotion(specMotion: "standard", reduceMotion: false).enabled)
    }

    func testSpecMotionNoneOrReduceMotionTurnsItOff() {
        XCTAssertFalse(PrototypeMotion(specMotion: "none", reduceMotion: false).enabled)
        XCTAssertFalse(PrototypeMotion(specMotion: nil, reduceMotion: true).enabled)
        XCTAssertFalse(PrototypeMotion(specMotion: "standard", reduceMotion: true).enabled)
    }

    func testNodeTransitionPicksTheVisibilityAnimation() {
        let motion = PrototypeMotion(specMotion: nil, reduceMotion: false)
        XCTAssertEqual(motion.visibility(transition: nil), .standard)
        XCTAssertEqual(motion.visibility(transition: "none"), .instant)
        XCTAssertEqual(motion.visibility(transition: "fade"), .fade)
        XCTAssertEqual(motion.visibility(transition: "expand"), .expand)
        XCTAssertEqual(motion.visibility(transition: "slide"), .slide)
    }

    func testDisabledMotionIsInstantWhateverTheTransition() {
        let off = PrototypeMotion(specMotion: "none", reduceMotion: false)
        XCTAssertEqual(
            ["fade", "expand", "slide", nil].map { off.visibility(transition: $0) },
            Array(repeating: .instant, count: 4)
        )
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

    private func snackbar(durationMs: Int?, open: Bool = true) throws -> (PrototypeSession, PrototypeNode) {
        let duration = durationMs.map { #","durationMs":\#($0)"# } ?? ""
        var session = PrototypeSession()
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
        try timeouts.sync(openModals: XCTUnwrap(session.spec).root.openModals(
            state: session.state,
            pages: session.pages
        ))
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
        try timeouts.sync(openModals: XCTUnwrap(session.spec).root.openModals(
            state: session.state,
            pages: session.pages
        ))
        XCTAssertTrue(clock.timers.isEmpty)
    }

    func testClosingBeforeTheTimeoutCancelsIt() throws {
        let (session, _) = try snackbar(durationMs: 5000)
        let clock = FakeClock()
        var closed = 0
        let timeouts = SnackbarTimeouts(clock: clock) { _ in closed += 1 }
        let root = try XCTUnwrap(session.spec).root
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
        let open = try XCTUnwrap(session.spec).root.openModals(state: session.state, pages: session.pages)
        timeouts.sync(openModals: open)
        timeouts.sync(openModals: open)
        XCTAssertEqual(clock.timers.count, 1)
    }

    func testReopeningAfterCloseStartsAFreshTimer() throws {
        let (session, _) = try snackbar(durationMs: 5000)
        let clock = FakeClock()
        let timeouts = SnackbarTimeouts(clock: clock) { _ in }
        let root = try XCTUnwrap(session.spec).root
        timeouts.sync(openModals: root.openModals(state: ["s": .bool(true)], pages: [:]))
        timeouts.sync(openModals: [])
        timeouts.sync(openModals: root.openModals(state: ["s": .bool(true)], pages: [:]))
        XCTAssertEqual(clock.timers.map(\.cancelled), [true, false])
    }

    // MARK: Container size animation (#10442)

    func testContainerSizeAnimatesUnlessMotionIsOff() {
        XCTAssertEqual(PrototypeMotion(specMotion: nil, reduceMotion: false).containerSizeDuration, 0.25)
        XCTAssertNil(PrototypeMotion(specMotion: "none", reduceMotion: false).containerSizeDuration)
        XCTAssertNil(PrototypeMotion(specMotion: nil, reduceMotion: true).containerSizeDuration)
    }

    private func column() throws -> PrototypeNode {
        try spec("""
        {"id":"a","window":{"placement":{"type":"fullscreen"}},"root":{"type":"column","children":[
          {"type":"text","text":"a","visibleWhen":{"key":"on","equals":true}},
          {"type":"box","style":{"height":{"dp":10}},
           "styleWhen":[{"when":{"key":"big","equals":true},"style":{"height":{"dp":40}}}]},
          {"type":"text","text":"c"}]}}
        """).root
    }

    func testLayoutSignatureChangesWhenAChildAppearsOrResizes() throws {
        let root = try column()
        let sig = { (state: [String: JSONValue]) in
            root.containerLayoutSignature(state: state) { $0.holds(state) }
        }
        let base = sig([:])
        XCTAssertEqual(base.count, 3)
        XCTAssertNotEqual(base, sig(["on": .bool(true)]))
        XCTAssertNotEqual(base, sig(["big": .bool(true)]))
    }

    func testLayoutSignatureIgnoresUnrelatedStateChanges() throws {
        let root = try column()
        let sig = { (state: [String: JSONValue]) in
            root.containerLayoutSignature(state: state) { $0.holds(state) }
        }
        XCTAssertEqual(sig([:]), sig(["typed": .string("hello")]))
    }

    // MARK: Press scale and stack slots (#10912)

    func testPressScaleSnapsUnderSpecMotionNoneOrReduceMotion() {
        XCTAssertEqual(PrototypeMotion(specMotion: nil, reduceMotion: false).pressScaleDuration, 0.2)
        XCTAssertNil(PrototypeMotion(specMotion: "none", reduceMotion: false).pressScaleDuration)
        XCTAssertNil(PrototypeMotion(specMotion: nil, reduceMotion: true).pressScaleDuration)
    }

    func testOnlyNodesThatDrawInPlaceTakeAStackSlot() throws {
        func node(_ json: String) throws -> PrototypeNode {
            try JSONDecoder().decode(PrototypeNode.self, from: Data(json.utf8))
        }
        let anchor = #""anchor": {"type": "bounds", "bounds": {"x": 0, "y": 0, "width": 1, "height": 1}}"#
        let column = try node("""
        {"type": "column", "children": [
          {"type": "text", "text": "shown"},
          {"type": "text", "text": "hidden", "visibleWhen": {"key": "on", "equals": true}},
          {"type": "text", "text": "anchored", \(anchor)},
          {"type": "dialog", "title": "d", "openWhen": {"key": "on", "equals": true}},
          {"type": "bottomSheet", "openWhen": {"key": "on", "equals": true}, "child": {"type": "text", "text": "s"}},
          {"type": "text", "text": "last", "visibleWhen": {"key": "on", "equals": false}}
        ]}
        """)
        func offsets(_ state: [String: JSONValue]) -> [Int] {
            column.drawnChildren { $0.holds(state) }.map(\.offset)
        }
        XCTAssertEqual(offsets([:]), [0])
        XCTAssertEqual(offsets(["on": .bool(true)]), [0, 1, 4])
        XCTAssertEqual(offsets(["on": .bool(false)]), [0, 5])
    }
}
