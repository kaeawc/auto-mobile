@testable import AutoMobilePrototypeAgentCore
import XCTest

private final class StandaloneTimer: PrototypeTimerHandle {
    let fire: () -> Void
    private(set) var cancelled = false
    init(fire: @escaping () -> Void) { self.fire = fire }
    func cancel() { cancelled = true }
    func run() {
        guard !cancelled else { return }
        cancelled = true
        fire()
    }
}

private final class StandaloneClock: PrototypeClock {
    private(set) var timers: [StandaloneTimer] = []
    func schedule(afterMilliseconds _: Int, _ fire: @escaping () -> Void) -> PrototypeTimerHandle {
        let timer = StandaloneTimer(fire: fire)
        timers.append(timer)
        return timer
    }

    func elapse() { timers.forEach { $0.run() } }
}

/// Mirrors model activity/expiry and authenticated-client delivery without UIKit or real time.
private final class StandaloneHarness {
    let mode: PrototypeLifecycleMode
    var session = PrototypeSession()
    var tracker = PrototypeClientTracker<Int>()
    var outbox: PrototypeEventOutbox<PrototypeEvent>
    var delivered: [PrototypeEvent] = []
    let clock = StandaloneClock()
    lazy var timer = PrototypeIdleTimer(clock: clock) { [unowned self] in dismiss(.ttl) }

    init(mode: PrototypeLifecycleMode) {
        self.mode = mode
        outbox = PrototypeEventOutbox(mode: mode)
    }

    func show(_ spec: PrototypeSpec) {
        session.show(spec)
        if mode.expiresWhenIdle { timer.arm() }
        if tracker.count < 1, mode.endsWithHost { dismiss(.disconnect) }
    }

    func apply(activity: Bool = true, _ transition: (inout PrototypeSession) -> [PrototypeEvent]) {
        let events = session.transition(transition)
        if session.isShown {
            if activity, mode.expiresWhenIdle { timer.arm() }
        } else {
            timer.cancel()
        }
        for event in events {
            delivered += outbox.publish(event)
        }
    }

    func dismiss(_ reason: PrototypeDismissReason) {
        apply(activity: false) { $0.dismiss(reason: reason) }
    }

    func connect(_ id: Int) {
        if let count = tracker.authenticate(id) { countChanged(count) }
    }

    func disconnect(_ id: Int) {
        if let count = tracker.close(id) { countChanged(count) }
    }

    private func countChanged(_ count: Int) {
        if count < 1, mode.endsWithHost { dismiss(.disconnect) }
        delivered += outbox.clientCountChanged(count)
    }
}

final class PrototypeStandaloneTests: XCTestCase {
    func testRingDropsOldestAndKeepsCumulativeCountAfterDrain() {
        var buffer = PrototypeOfflineEventBuffer<Int>()
        for event in 1 ... 201 {
            buffer.add(event)
        }
        XCTAssertEqual(buffer.count, 200)
        XCTAssertEqual(buffer.dropped, 1)
        XCTAssertEqual(buffer.drain(), Array(2 ... 201))
        XCTAssertEqual(buffer.count, 0)
        XCTAssertEqual(buffer.dropped, 1)
        XCTAssertEqual(buffer.drain(), [])
        for event in 202 ... 402 {
            buffer.add(event)
        }
        XCTAssertEqual(buffer.drain(), Array(203 ... 402))
        XCTAssertEqual(buffer.dropped, 2)
    }

    func testRingWrapsAfterMultipleOverflowsAndSupportsSmallCapacity() {
        var buffer = PrototypeOfflineEventBuffer<Int>(capacity: 2)
        for event in 1 ... 7 {
            buffer.add(event)
        }
        XCTAssertEqual(buffer.count, 2)
        XCTAssertEqual(buffer.dropped, 5)
        XCTAssertEqual(buffer.drain(), [6, 7])
        buffer.add(8)
        XCTAssertEqual(buffer.drain(), [8])
        XCTAssertEqual(buffer.dropped, 5)
    }

    func testStandaloneOutboxFlushesOnConnectAndBuffersAgainOnDisconnect() {
        var outbox = PrototypeEventOutbox<Int>(mode: .standalone)
        XCTAssertEqual(outbox.clients, 0)
        XCTAssertEqual(outbox.publish(1), [])
        XCTAssertEqual(outbox.publish(2), [])
        XCTAssertEqual(outbox.bufferedCount, 2)
        XCTAssertEqual(outbox.clientCountChanged(1), [1, 2])
        XCTAssertEqual(outbox.clients, 1)
        XCTAssertEqual(outbox.bufferedCount, 0)
        XCTAssertEqual(outbox.publish(3), [3])
        XCTAssertEqual(outbox.clientCountChanged(2), [])
        XCTAssertEqual(outbox.clientCountChanged(0), [])
        for event in 4 ... 208 {
            XCTAssertEqual(outbox.publish(event), [])
        }
        XCTAssertEqual(outbox.bufferedCount, 200)
        XCTAssertEqual(outbox.droppedEvents, 5)
        XCTAssertEqual(outbox.clientCountChanged(1), Array(9 ... 208))
        XCTAssertEqual(outbox.clientCountChanged(0), [])
        XCTAssertEqual(outbox.publish(209), [])
        XCTAssertEqual(outbox.publish(210), [])
        XCTAssertEqual(outbox.drainForInspect(), [209, 210])
        XCTAssertEqual(outbox.drainForInspect(), [])
        XCTAssertEqual(outbox.bufferedCount, 0)
        XCTAssertEqual(outbox.droppedEvents, 5)
    }

    func testSessionOutboxAlwaysPublishesWithoutBuffering() {
        var outbox = PrototypeEventOutbox<Int>(mode: .session)
        for event in 1 ... 500 {
            XCTAssertEqual(outbox.clientCountChanged(event % 2), [])
            XCTAssertEqual(outbox.publish(event), [event])
        }
        XCTAssertEqual(outbox.drainForInspect(), [])
        XCTAssertEqual(outbox.bufferedCount, 0)
        XCTAssertEqual(outbox.droppedEvents, 0)
    }

    func testModePoliciesAndCapabilityAdvertising() {
        let session = PrototypeLifecycleMode.session
        let standalone = PrototypeLifecycleMode.standalone
        XCTAssertTrue(session.expiresWhenIdle)
        XCTAssertTrue(session.endsWithHost)
        XCTAssertFalse(session.buffersOffline)
        XCTAssertFalse(standalone.expiresWhenIdle)
        XCTAssertFalse(standalone.endsWithHost)
        XCTAssertTrue(standalone.buffersOffline)
        let capabilities = ["show_prototype", "get_prototype_status"]
        let replay = PrototypeLifecycleMode.persistenceReplayCapability
        XCTAssertEqual(session.advertising(capabilities), capabilities)
        XCTAssertEqual(standalone.advertising(capabilities), capabilities + [replay])
        let advertised = standalone.advertising(capabilities)
        XCTAssertEqual(standalone.advertising(advertised), advertised)
        XCTAssertEqual(session.advertising(advertised), advertised)
    }

    func testStandaloneSurvivesOfflineShowTtlAndDisconnectAndReplaysSequences() throws {
        let harness = StandaloneHarness(mode: .standalone)
        try harness.show(textSpec())
        XCTAssertTrue(harness.session.isShown)
        XCTAssertTrue(harness.clock.timers.isEmpty)
        harness.clock.elapse()
        XCTAssertTrue(harness.session.isShown)
        XCTAssertTrue(harness.delivered.isEmpty)
        harness.apply { $0.setStates([("value", .number(1))]) }
        harness.apply { $0.setStates([("value", .number(2))]) }
        XCTAssertTrue(harness.delivered.isEmpty)
        harness.connect(1)
        XCTAssertEqual(harness.delivered.map(\.sequence), [1, 2])
        XCTAssertEqual(harness.delivered.map { $0.state["value"] }, [.number(1), .number(2)])
        harness.disconnect(1)
        XCTAssertTrue(harness.session.isShown)
        harness.apply { $0.setStates([("value", .number(3))]) }
        harness.clock.elapse()
        XCTAssertTrue(harness.session.isShown)
        XCTAssertEqual(harness.outbox.bufferedCount, 1)
        harness.connect(2)
        XCTAssertEqual(harness.delivered.map(\.sequence), [1, 2, 3])
        XCTAssertFalse(harness.delivered.contains { $0.kind == "dismissed" })
        XCTAssertTrue(harness.clock.timers.isEmpty)
    }

    func testSessionHarnessStillDismissesForTtlAndDisconnect() throws {
        let ttl = StandaloneHarness(mode: .session)
        ttl.connect(1)
        try ttl.show(textSpec())
        ttl.clock.elapse()
        XCTAssertFalse(ttl.session.isShown)
        XCTAssertEqual(ttl.delivered.map(\.kind), ["dismissed"])
        XCTAssertEqual(ttl.delivered.map(reason), ["ttl"])
        let disconnect = StandaloneHarness(mode: .session)
        disconnect.connect(1)
        disconnect.connect(2)
        try disconnect.show(textSpec())
        disconnect.disconnect(1)
        XCTAssertTrue(disconnect.session.isShown)
        disconnect.disconnect(2)
        XCTAssertFalse(disconnect.session.isShown)
        XCTAssertEqual(disconnect.delivered.map(reason), ["disconnect"])
        XCTAssertFalse(disconnect.timer.isArmed)
        let offline = StandaloneHarness(mode: .session)
        try offline.show(textSpec())
        XCTAssertFalse(offline.session.isShown)
        XCTAssertEqual(offline.delivered.map(reason), ["disconnect"])
    }

    private func textSpec() throws -> PrototypeSpec {
        try JSONDecoder().decode(PrototypeSpec.self, from: Data("""
        {"id":"a","window":{"placement":{"type":"fullscreen"}},"root":{"type":"text","text":"hi"}}
        """.utf8))
    }

    private func reason(_ event: PrototypeEvent) -> String? {
        guard case let .object(payload) = event.payload, case let .string(reason)? = payload["reason"] else {
            return nil
        }
        return reason
    }
}
