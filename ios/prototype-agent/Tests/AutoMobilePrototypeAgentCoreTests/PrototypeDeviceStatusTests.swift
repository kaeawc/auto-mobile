@testable import AutoMobilePrototypeAgentCore
import XCTest

private final class DeviceStatusTimer: PrototypeTimerHandle {
    let fire: () -> Void
    var cancelled = false
    init(_ fire: @escaping () -> Void) { self.fire = fire }
    func cancel() { cancelled = true }
}

private final class DeviceStatusClock: PrototypeClock {
    var nowMilliseconds = 0
    private(set) var delays: [Int] = []
    private var timers: [DeviceStatusTimer] = []
    var live: Int { timers.filter { !$0.cancelled }.count }

    func schedule(afterMilliseconds delay: Int, _ fire: @escaping () -> Void) -> any PrototypeTimerHandle {
        let timer = DeviceStatusTimer(fire)
        delays.append(delay)
        timers.append(timer)
        return timer
    }

    func elapse() {
        for timer in timers where !timer.cancelled {
            timer.cancel()
            timer.fire()
        }
    }
}

@MainActor
private final class FakeDeviceStatusSource: PrototypeDeviceStatusSource {
    private(set) var starts = 0
    private var update: (@MainActor @Sendable ([String: JSONValue]) -> Void)?
    let initial: [String: JSONValue]
    init(_ initial: [String: JSONValue]) { self.initial = initial }

    func start(_ update: @escaping @MainActor @Sendable ([String: JSONValue]) -> Void) {
        starts += 1
        self.update = update
        update(initial)
    }

    func stop() { update = nil }
    func report(_ state: [String: JSONValue]) { update?(state) }
}

@MainActor
final class PrototypeDeviceStatusTests: XCTestCase {
    func testThermalAndBatteryStateTables() {
        for (raw, expected) in ["nominal", "fair", "serious", "critical"].enumerated() {
            XCTAssertEqual(PrototypeDeviceStatus.thermal(raw), expected)
        }
        for raw in [-1, 4, Int.min, Int.max] {
            XCTAssertNil(PrototypeDeviceStatus.thermal(raw))
            XCTAssertEqual(PrototypeDeviceStatus.batteryState(raw), "unknown")
        }
        for (raw, expected) in ["unknown", "unplugged", "charging", "full"].enumerated() {
            XCTAssertEqual(PrototypeDeviceStatus.batteryState(raw), expected)
        }
    }

    func testBatteryAndVolumePercentagesMatchTheReference() {
        let cases: [(Double, Double?)] = [
            (-1, nil), (-0.1, nil), (.nan, nil), (.infinity, nil), (-.infinity, nil),
            (0, 0), (0.004, 0), (0.005, 1), (0.5, 50), (0.999, 100), (1, 100),
            (1.5, 100), (Double.greatestFiniteMagnitude, 100),
        ]
        for (raw, expected) in cases {
            XCTAssertEqual(PrototypeDeviceStatus.batteryLevel(raw), expected)
            XCTAssertEqual(PrototypeDeviceStatus.volume(raw), expected)
        }
        var state: [String: JSONValue] = [:]
        state["level"] = PrototypeDeviceStatus.batteryLevel(-1).map(JSONValue.number)
        XCTAssertNil(state["level"], "unknown levels must be absent, not null or zero")
    }

    func testRouteKinds() {
        let cases = [
            "": "speaker", "Speaker": "speaker", "Receiver": "speaker",
            "Headphones": "wired", "LineOut": "wired", "BluetoothA2DPOutput": "bluetooth",
            "BluetoothLE": "bluetooth", "BluetoothHFP": "bluetooth", "USBAudio": "usb",
            "AirPlay": "airplay", "HDMI": "other", "future-port": "other",
        ]
        for (raw, expected) in cases {
            XCTAssertEqual(PrototypeDeviceStatus.route(raw), expected)
        }
    }

    func testFactoriesReadContractAndStartLazilyOnce() async {
        let source = FakeDeviceStatusSource(["state": .string("unknown")])
        let clock = DeviceStatusClock()
        let modules = [
            PrototypeDeviceStatusModule.battery(source: source, clock: clock),
            PrototypeDeviceStatusModule.power(source: source, clock: clock),
            PrototypeDeviceStatusModule.audio(source: source, clock: clock),
        ]
        XCTAssertEqual(source.starts, 0)
        for module in modules {
            XCTAssertEqual(module.capability, "prototype_platform_\(module.name)_v1")
            XCTAssertEqual(module.debounceMs, 500)
            XCTAssertEqual(module.availability(), .ready)
            XCTAssertEqual(module.requiredInfoPlistKeys, [])
            XCTAssertEqual(module.state, source.initial)
            _ = module.state
            _ = module.events
            let result = await module.call(PlatformCall(callId: "c", call: "\(module.name).read", args: [:]))
            XCTAssertEqual(result, .failure(.unsupported, "The \(module.name) module has no calls"))
        }
        XCTAssertEqual(source.starts, 3)
        XCTAssertEqual(clock.delays, [], "synchronous baselines never schedule an event")
    }

    func testChangesRefreshImmediatelyAndABurstDeliversOnlyTheLatestState() async {
        for name in ["battery", "power", "audio"] {
            let baseline: [String: JSONValue] = ["value": .number(0)]
            let first: [String: JSONValue] = ["value": .number(1)]
            let last: [String: JSONValue] = ["value": .number(2)]
            let source = FakeDeviceStatusSource(baseline)
            let clock = DeviceStatusClock()
            let module = PrototypeDeviceStatusModule(
                name: name, capability: "prototype_platform_\(name)_v1", source: source, clock: clock
            )
            var events = module.events.makeAsyncIterator()
            source.report(first)
            XCTAssertEqual(module.state, first)
            source.report(last)
            source.report(last)
            XCTAssertEqual(module.state, last)
            XCTAssertEqual(clock.delays, [500, 500], "unchanged readings do not postpone delivery")
            XCTAssertEqual(clock.live, 1)
            clock.elapse()
            let refresh1 = await events.next()
            let refresh2 = await events.next()
            let changed = await events.next()
            XCTAssertEqual(refresh1, .stateRefresh(name))
            XCTAssertEqual(refresh2, .stateRefresh(name))
            XCTAssertEqual(changed, PlatformEvent(event: "\(name).changed", data: .object(last)))
        }
    }

    func testFlapBackDeliversNoEventAndAnUnknownKeyCanDisappear() async {
        let baseline: [String: JSONValue] = ["state": .string("unknown")]
        let known: [String: JSONValue] = ["state": .string("unknown"), "level": .number(50)]
        let source = FakeDeviceStatusSource(baseline)
        let clock = DeviceStatusClock()
        let module = PrototypeDeviceStatusModule.battery(source: source, clock: clock)
        var events = module.events.makeAsyncIterator()
        source.report(known)
        source.report(baseline)
        XCTAssertNil(module.state["level"])
        clock.elapse()
        source.report(known)
        clock.elapse()
        // The later real change also provides a sentinel: an erroneous baseline/flap event
        // would appear before it. Everything is buffered; no sleeps or wall-clock timers run.
        var received: [PlatformEvent] = []
        for _ in 0 ..< 4 {
            if let event = await events.next() { received.append(event) }
        }
        XCTAssertEqual(received, [
            .stateRefresh("battery"), .stateRefresh("battery"), .stateRefresh("battery"),
            PlatformEvent(event: "battery.changed", data: .object(known)),
        ])
    }
}
