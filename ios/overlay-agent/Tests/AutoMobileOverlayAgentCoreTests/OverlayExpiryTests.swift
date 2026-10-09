@testable import AutoMobileOverlayAgentCore
import XCTest

private final class ExpiryTimer: OverlayTimerHandle {
    let delay: Int
    let fire: () -> Void
    private(set) var cancelled = false
    init(delay: Int, fire: @escaping () -> Void) {
        self.delay = delay
        self.fire = fire
    }

    func cancel() { cancelled = true }

    /// A real one-shot timer runs once and is then spent.
    func run() {
        guard !cancelled else { return }
        cancelled = true
        fire()
    }
}

private final class ExpiryClock: OverlayClock {
    private(set) var timers: [ExpiryTimer] = []

    func schedule(afterMilliseconds: Int, _ fire: @escaping () -> Void) -> OverlayTimerHandle {
        let timer = ExpiryTimer(delay: afterMilliseconds, fire: fire)
        timers.append(timer)
        return timer
    }

    var live: [ExpiryTimer] { timers.filter { !$0.cancelled } }

    /// Fires the live timer, as if its delay elapsed (a cancelled one never runs, like a real one).
    func elapse() {
        live.forEach { $0.run() }
    }
}

/// The agent's expiry wiring without UIKit: a session, an idle timer that dismisses with `ttl`,
/// and the host-disconnect rule, in the order `OverlayModel` and `OverlayAgent` apply them.
private final class ExpiryHarness {
    var session = OverlaySession()
    var events: [OverlayEvent] = []
    var tracker = OverlayClientTracker<Int>()
    let clock = ExpiryClock()
    lazy var timer = OverlayIdleTimer(clock: clock) { [unowned self] in
        dismiss(.ttl)
    }

    func show(_ spec: OverlaySpec) {
        session.show(spec)
        timer.arm()
        if tracker.count == 0 { dismiss(.disconnect) }
    }

    func dismiss(_ reason: OverlayDismissReason) {
        events += session.dismiss(reason: reason)
        if !session.isShown { timer.cancel() }
    }

    func clientClosed(_ id: Int) {
        if tracker.close(id) == 0 { dismiss(.disconnect) }
    }
}

final class OverlayExpiryTests: XCTestCase {
    private func textSpec(id: String) throws -> OverlaySpec {
        try JSONDecoder().decode(OverlaySpec.self, from: Data("""
        {"id":"\(id)","window":{"placement":{"type":"fullscreen"}},"root":{"type":"text","text":"hi"}}
        """.utf8))
    }

    private func reason(_ event: OverlayEvent) -> String? {
        guard case let .object(payload) = event.payload, case let .string(reason)? = payload["reason"] else {
            return nil
        }
        return reason
    }

    // MARK: Idle timer

    func testDefaultTtlIsFiveMinutes() {
        XCTAssertEqual(OverlayIdleTimer.defaultTtlMilliseconds, 300_000)
        let clock = ExpiryClock()
        OverlayIdleTimer(clock: clock) {}.arm()
        XCTAssertEqual(clock.live.map(\.delay), [300_000])
    }

    func testExpiresOnceAfterTheTtl() {
        let clock = ExpiryClock()
        var expired = 0
        let timer = OverlayIdleTimer(clock: clock, ttlMilliseconds: 1000) { expired += 1 }
        timer.arm()
        XCTAssertTrue(timer.isArmed)
        clock.elapse()
        XCTAssertEqual(expired, 1)
        XCTAssertFalse(timer.isArmed)
        clock.elapse()
        XCTAssertEqual(expired, 1, "a spent timer does not fire again")
    }

    func testActivityRestartsTheCountdown() {
        let clock = ExpiryClock()
        var expired = 0
        let timer = OverlayIdleTimer(clock: clock, ttlMilliseconds: 1000) { expired += 1 }
        timer.arm()
        let first = clock.timers[0]
        timer.arm()
        XCTAssertTrue(first.cancelled)
        XCTAssertEqual(clock.live.count, 1)
        // Even if the superseded timer's callback still ran, it must not expire the new countdown.
        first.fire()
        XCTAssertEqual(expired, 0)
        clock.elapse()
        XCTAssertEqual(expired, 1)
    }

    func testCancelStopsTheCountdown() {
        let clock = ExpiryClock()
        var expired = 0
        let timer = OverlayIdleTimer(clock: clock, ttlMilliseconds: 1000) { expired += 1 }
        timer.arm()
        timer.cancel()
        clock.timers.forEach { $0.fire() }
        XCTAssertEqual(expired, 0)
        XCTAssertFalse(timer.isArmed)
    }

    func testTtlOverrideAppliesFromTheNextArm() {
        let clock = ExpiryClock()
        let timer = OverlayIdleTimer(clock: clock, ttlMilliseconds: 1000) {}
        timer.arm()
        timer.ttlMilliseconds = 250
        timer.arm()
        XCTAssertEqual(clock.live.map(\.delay), [250])
    }

    // MARK: Client tracking

    func testCountsOnlyAuthenticatedConnectionsAndReportsEdges() {
        var tracker = OverlayClientTracker<Int>()
        XCTAssertNil(tracker.close(1), "an unauthenticated connection never counted")
        XCTAssertEqual(tracker.authenticate(1), 1)
        XCTAssertNil(tracker.authenticate(1), "authenticating twice does not double count")
        XCTAssertEqual(tracker.authenticate(2), 2)
        XCTAssertEqual(tracker.close(1), 1)
        XCTAssertNil(tracker.close(1), "failed then cancelled reports one close")
        XCTAssertEqual(tracker.close(2), 0)
        XCTAssertEqual(tracker.count, 0)
    }

    // MARK: Reasons and events

    func testTtlExpiryEmitsOneDismissedEventWithReasonTtl() throws {
        let harness = ExpiryHarness()
        _ = harness.tracker.authenticate(1)
        try harness.show(textSpec(id: "a"))
        XCTAssertTrue(harness.session.isShown)
        harness.clock.elapse()
        XCTAssertFalse(harness.session.isShown)
        XCTAssertEqual(harness.events.map(\.kind), ["dismissed"])
        XCTAssertEqual(harness.events.map(reason), ["ttl"])
        XCTAssertEqual(harness.events.map(\.sequence), [1])
        XCTAssertNil(harness.events.first?.name)
    }

    func testReplacingShowRestartsTheTtl() throws {
        let harness = ExpiryHarness()
        _ = harness.tracker.authenticate(1)
        try harness.show(textSpec(id: "a"))
        let first = harness.clock.timers[0]
        try harness.show(textSpec(id: "a"))
        XCTAssertTrue(first.cancelled)
        XCTAssertEqual(harness.clock.live.count, 1)
    }

    func testLastClientDisconnectEmitsReasonDisconnectAndCancelsTheTtl() throws {
        let harness = ExpiryHarness()
        _ = harness.tracker.authenticate(1)
        _ = harness.tracker.authenticate(2)
        try harness.show(textSpec(id: "a"))
        harness.clientClosed(1)
        XCTAssertTrue(harness.session.isShown, "another host is still connected")
        harness.clientClosed(2)
        XCTAssertFalse(harness.session.isShown)
        XCTAssertEqual(harness.events.map(reason), ["disconnect"])
        XCTAssertTrue(harness.clock.live.isEmpty, "a dismissed overlay has no pending TTL")
    }

    func testShowAfterTheLastClientLeftIsDismissedAsDisconnect() throws {
        let harness = ExpiryHarness()
        _ = harness.tracker.authenticate(1)
        harness.clientClosed(1)
        XCTAssertTrue(harness.events.isEmpty, "nothing was showing")
        try harness.show(textSpec(id: "a"))
        XCTAssertFalse(harness.session.isShown)
        XCTAssertEqual(harness.events.map(reason), ["disconnect"])
    }

    func testReconnectBeforeTheNextShowKeepsTheNewOverlay() throws {
        let harness = ExpiryHarness()
        _ = harness.tracker.authenticate(1)
        harness.clientClosed(1)
        _ = harness.tracker.authenticate(2)
        try harness.show(textSpec(id: "a"))
        XCTAssertTrue(harness.session.isShown)
        XCTAssertTrue(harness.events.isEmpty)
    }

    func testDismissReasonWireStringsMatchAndroid() {
        XCTAssertEqual(OverlayDismissReason.disconnect.rawValue, "disconnect")
        XCTAssertEqual(OverlayDismissReason.ttl.rawValue, "ttl")
    }
}
