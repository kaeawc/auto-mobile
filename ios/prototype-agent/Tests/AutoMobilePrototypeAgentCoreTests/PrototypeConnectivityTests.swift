@testable import AutoMobilePrototypeAgentCore
import XCTest

private final class ConnectivityTimer: PrototypeTimerHandle {
    let fire: () -> Void
    var cancelled = false
    init(_ fire: @escaping () -> Void) { self.fire = fire }
    func cancel() { cancelled = true }
}

/// Fires only when told to, so the debounce runs without real time.
private final class ConnectivityClock: PrototypeClock {
    var nowMilliseconds = 0
    private(set) var delays: [Int] = []
    private var timers: [ConnectivityTimer] = []
    func schedule(afterMilliseconds delay: Int, _ fire: @escaping () -> Void) -> any PrototypeTimerHandle {
        let timer = ConnectivityTimer(fire)
        delays.append(delay)
        timers.append(timer)
        return timer
    }

    var live: Int { timers.filter { !$0.cancelled }.count }

    func elapse() {
        for timer in timers where !timer.cancelled {
            timer.cancel()
            timer.fire()
        }
    }
}

/// Models NWPathMonitor: nothing is reported until start, then each `report` is one path update.
@MainActor
private final class FakeConnectivitySource: PrototypeConnectivitySource {
    private(set) var starts = 0
    private(set) var stops = 0
    private var update: (@MainActor @Sendable (PrototypeConnectivityReading) -> Void)?
    func start(_ update: @escaping @MainActor @Sendable (PrototypeConnectivityReading) -> Void) {
        starts += 1
        self.update = update
    }

    func stop() { stops += 1 }
    func report(_ reading: PrototypeConnectivityReading) { update?(reading) }
}

@MainActor
final class PrototypeConnectivityTests: XCTestCase {
    private let wifi = PrototypeConnectivityReading(
        satisfied: true, interfaces: [.wifi], expensive: false, constrained: false
    )
    private let cellular = PrototypeConnectivityReading(
        satisfied: true, interfaces: [.cellular], expensive: true, constrained: true
    )

    private func state(_ online: Bool, _ transport: String, _ metered: Bool, _ constrained: Bool)
        -> [String: JSONValue]
    {
        [
            "online": .bool(online),
            "transport": .string(transport),
            "metered": .bool(metered),
            "constrained": .bool(constrained),
        ]
    }

    func testMappingCoversOfflineTransportsAndLowDataMode() {
        XCTAssertEqual(PrototypeConnectivityReading.offline.state, state(false, "none", false, false))
        let detached = PrototypeConnectivityReading(
            satisfied: false,
            interfaces: [],
            expensive: true,
            constrained: true
        )
        XCTAssertEqual(detached.state, state(false, "none", false, false), "no interface is never metered")
        XCTAssertEqual(wifi.state, state(true, "wifi", false, false))
        XCTAssertEqual(cellular.state, state(true, "cellular", true, true))
        let cases: [(Set<PrototypeConnectivityReading.Interface>, String)] = [
            ([.wifi, .cellular], "wifi"), ([.cellular, .wiredEthernet], "cellular"),
            ([.wiredEthernet], "ethernet"), ([.other], "other"),
        ]
        for (interfaces, transport) in cases {
            let reading = PrototypeConnectivityReading(
                satisfied: true, interfaces: interfaces, expensive: false, constrained: false
            )
            XCTAssertEqual(reading.state["transport"], .string(transport))
        }
        let waiting = PrototypeConnectivityReading(
            satisfied: false, interfaces: [.wifi], expensive: true, constrained: false
        )
        XCTAssertEqual(waiting.state, state(false, "wifi", true, false))
    }

    func testRegistrationDoesNotStartTheMonitorAndTheFirstReadDoes() {
        let source = FakeConnectivitySource()
        let module = PrototypeConnectivityModule(source: source, clock: ConnectivityClock())
        XCTAssertEqual(source.starts, 0)
        XCTAssertEqual(module.state, state(false, "none", false, false))
        _ = module.state
        XCTAssertEqual(source.starts, 1)
    }

    /// The first `count` events, or what arrived within a second, so a missing event fails
    /// instead of hanging. A passing test never waits.
    private func collect(_ stream: AsyncStream<PlatformEvent>, _ count: Int) async -> [PlatformEvent] {
        await withTaskGroup(of: [PlatformEvent]?.self) { group in
            group.addTask {
                var events: [PlatformEvent] = []
                for await event in stream {
                    events.append(event)
                    if events.count == count { return events }
                }
                return events
            }
            group.addTask {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                return nil
            }
            let first = await group.next()
            group.cancelAll()
            return (first ?? nil) ?? []
        }
    }

    func testFirstReadingIsTheBaselineAndLaterChangesTrailTheDebounce() async {
        let source = FakeConnectivitySource()
        let clock = ConnectivityClock()
        let module = PrototypeConnectivityModule(source: source, clock: clock)
        let stream = module.events
        source.report(wifi)
        XCTAssertEqual(module.state, state(true, "wifi", false, false))
        XCTAssertEqual(clock.live, 0, "the baseline reading schedules no event")
        source.report(.offline)
        source.report(cellular)
        XCTAssertEqual(clock.live, 1, "a newer reading replaces the pending one")
        XCTAssertEqual(clock.delays.last, PrototypeConnectivityModule.debounceMs)
        clock.elapse()
        let refresh = PlatformEvent.stateRefresh("connectivity")
        let events = await collect(stream, 4)
        XCTAssertEqual(events, [
            refresh, refresh, refresh,
            PlatformEvent(event: "connectivity.changed", data: .object(cellular.state)),
        ])
    }

    func testAFlapBackToTheDeliveredStateIsNotAnEvent() async {
        let source = FakeConnectivitySource()
        let clock = ConnectivityClock()
        let module = PrototypeConnectivityModule(source: source, clock: clock)
        let stream = module.events
        source.report(wifi)
        source.report(.offline)
        source.report(wifi)
        clock.elapse()
        source.report(cellular)
        clock.elapse()
        let events = await collect(stream, 5)
        XCTAssertEqual(events.map(\.event), Array(repeating: "connectivity.$state", count: 4) + [
            "connectivity.changed",
        ], "the flap refreshed state but delivered no event")
        XCTAssertEqual(events.last?.data, .object(cellular.state))
    }

    func testAnUnchangedReadingRefreshesNothing() async {
        let source = FakeConnectivitySource()
        let clock = ConnectivityClock()
        let module = PrototypeConnectivityModule(source: source, clock: clock)
        let stream = module.events
        source.report(.offline)
        source.report(wifi)
        source.report(wifi)
        source.report(cellular)
        clock.elapse()
        let events = await collect(stream, 3)
        XCTAssertEqual(events.map(\.event), [
            "connectivity.$state", "connectivity.$state", "connectivity.changed",
        ], "the two unchanged readings refreshed nothing")
    }

    func testTheModuleHasNoCallsAndTheContractDebounce() async {
        let module = PrototypeConnectivityModule(source: FakeConnectivitySource(), clock: ConnectivityClock())
        let result = await module.call(PlatformCall(callId: "c", call: "connectivity.read", args: [:]))
        XCTAssertEqual(result, .failure(.unsupported, "The connectivity module has no calls"))
        XCTAssertEqual(PrototypeConnectivityModule.debounceMs, 500)
    }
}
