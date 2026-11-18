@testable import AutoMobilePrototypeAgentCore
import Foundation
import XCTest

private final class SensorClock: PrototypeMonotonicClock {
    var monotonicMilliseconds = 0
}

@MainActor
private struct SensorBundle: PrototypeBundleReader {
    var hasMotionUsage = true
    func containsInfoPlistKey(_ key: String) -> Bool { hasMotionUsage && key == "NSMotionUsageDescription" }
}

@MainActor
private final class SensorSource: PrototypeSensorSource {
    var available = Set(PrototypeSensor.allCases)
    var stepsAllowed = true
    var queries: [PrototypeSensor] = []
    var starts: [(sensor: PrototypeSensor, rate: Int)] = []
    var handlers: [PrototypeSensor: @MainActor @Sendable (PrototypeSensorSample) -> Void] = [:]
    var stops = 0
    var duringStop: (@MainActor () -> Void)?
    var presentations: [SensorSource] = []

    func makePresentationSource() -> any PrototypeSensorSource {
        let source = SensorSource()
        source.available = available
        source.stepsAllowed = stepsAllowed
        presentations.append(source)
        return source
    }

    func hasSensor(_ sensor: PrototypeSensor) -> Bool {
        queries.append(sensor)
        return available.contains(sensor)
    }

    func start(
        _ sensor: PrototypeSensor, rateHz: Int,
        _ handler: @escaping @MainActor @Sendable (PrototypeSensorSample) -> Void
    ) {
        starts.append((sensor, rateHz))
        handlers[sensor] = handler
    }

    func stop() {
        stops += 1
        duringStop?()
        handlers.removeAll()
    }

    func report(_ sensor: PrototypeSensor, _ sample: PrototypeSensorSample) { handlers[sensor]?(sample) }
}

@MainActor
private final class SensorRegistryServices: PrototypeHapticsPlayer, PrototypeSoundPlayer,
    PrototypeConnectivitySource, PrototypeLinkOpener, PrototypeSettingsURLOpener
{
    func perform(_: PrototypeHapticEffect) -> PrototypeFeedbackOutcome { .unavailable }
    func play(_: PrototypeSoundCue, volume _: Int?) -> PrototypeFeedbackOutcome { .unavailable }
    func start(_: @escaping @MainActor @Sendable (PrototypeConnectivityReading) -> Void) {}
    func stop() {}
    var appSettingsURL: URL? { nil }
    var notificationSettingsURL: URL? { nil }
    func open(_: URL) async -> Bool { false }
    func openExternally(_: URL) async -> Bool { false }
    func presentInApp(_: URL) -> Bool { false }
}

private struct SensorValueFixture: Decodable {
    struct Sample: Decodable, Equatable {
        let timestampMs: Int
        let value: Double
    }

    let key: String
    let rateHz: Int
    let samples: [Sample]
    let expectedWrites: [Sample]
}

private struct SensorShakeFixture: Decodable {
    struct Sample: Decodable {
        let timestampMs: Int
        let x: Double
        let y: Double
        let z: Double
    }

    let samples: [Sample]
    let expectedShakes: [Int]
}

@MainActor
final class PrototypeSensorsTests: XCTestCase {
    private func fixture<T: Decodable>(_ name: String, as type: T.Type) throws -> T {
        let repository = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        return try JSONDecoder().decode(type, from: Data(contentsOf: repository.appendingPathComponent(
            "test/fixtures/prototype-sensors/\(name).json"
        )))
    }

    private func module(_ source: SensorSource, clock: SensorClock = SensorClock()) -> PrototypeSensorsModule {
        PrototypeSensorsModule(source: source, bundle: SensorBundle(), clock: clock)
    }

    private func block(_ sensors: PrototypeSensor...) -> JSONValue {
        .object(Dictionary(uniqueKeysWithValues: sensors.map { ($0.rawValue, .object([:])) }))
    }

    /// Uses the same actor-local buffered-stream drain as the location suite, with no sleeps.
    private func bufferedEvents(_ stream: AsyncStream<PlatformEvent>) async -> [PlatformEvent] {
        var collector: Task<[PlatformEvent], Never>?
        await withCheckedContinuation { ready in
            collector = Task { @MainActor in
                ready.resume()
                var values: [PlatformEvent] = []
                var iterator = stream.makeAsyncIterator()
                while let event = await iterator.next(isolation: MainActor.shared) {
                    values.append(event)
                }
                return values
            }
        }
        guard let collector else { return [] }
        collector.cancel()
        return await collector.value
    }

    func testAvailabilityAndNoCallsWithoutTouchingSource() async {
        let source = SensorSource()
        let module = module(source)
        XCTAssertEqual(module.name, "sensors")
        XCTAssertEqual(module.capability, "prototype_platform_sensors_v1")
        XCTAssertEqual(module.requiredInfoPlistKeys, [])
        XCTAssertEqual(module.availability(), .ready)
        let result = await module.call(PlatformCall(callId: "s", call: "sensors.request", args: [:]))
        XCTAssertEqual(result, .failure(.unsupported, "Sensors has no calls"))
        XCTAssertTrue(source.starts.isEmpty)
        XCTAssertTrue(source.queries.isEmpty)
        XCTAssertEqual(source.stops, 0)
    }

    func testSharedOrientationFixturesReplayThroughModule() async throws {
        for name in ["throttle-heading", "throttle-pitch-clamp"] {
            let fixture = try fixture(name, as: SensorValueFixture.self)
            let source = SensorSource()
            let clock = SensorClock()
            let module = module(source, clock: clock)
            let events = module.events
            module.configure(root: .object(["orientation": .object(["rateHz": .number(Double(fixture.rateHz))])]))
            XCTAssertEqual(source.starts.map(\.rate), [fixture.rateHz])
            var writes: [SensorValueFixture.Sample] = []
            for sample in fixture.samples {
                clock.monotonicMilliseconds = sample.timestampMs
                let before = module.state[fixture.key]
                source.report(.orientation, .values([fixture.key: sample.value]))
                if module.state[fixture.key] != before, let value = module.state[fixture.key]?.numberValue {
                    writes.append(.init(timestampMs: sample.timestampMs, value: value))
                }
            }
            XCTAssertEqual(writes, fixture.expectedWrites, name)
            let received = await bufferedEvents(events)
            XCTAssertEqual(received, Array(repeating: .stateRefresh("sensors"), count: writes.count + 1))
            module.configure(root: nil)
        }
    }

    func testSharedLightFixtureIsFilteredButNeverPublishedOrSubscribedOnIOS() async throws {
        let fixture = try fixture("throttle-light", as: SensorValueFixture.self)
        var filter = PrototypeSensorFilter(rateHz: fixture.rateHz)
        var writes: [SensorValueFixture.Sample] = []
        let source = SensorSource()
        let clock = SensorClock()
        let module = module(source, clock: clock)
        let events = module.events
        module.configure(root: .object([
            "light": .object(["rateHz": .number(Double(fixture.rateHz))]), "orientation": .object([:]),
        ]))
        for sample in fixture.samples {
            clock.monotonicMilliseconds = sample.timestampMs
            if let value = filter.write(key: fixture.key, raw: sample.value, at: sample.timestampMs) {
                writes.append(.init(timestampMs: sample.timestampMs, value: value))
            }
            source.report(.light, .values([fixture.key: sample.value]))
            // An available source cannot smuggle Android-only readings through another subscription.
            source.report(.orientation, .values([fixture.key: sample.value]))
        }
        XCTAssertEqual(writes, fixture.expectedWrites)
        XCTAssertFalse(source.queries.contains(.light))
        XCTAssertEqual(source.starts.map(\.sensor), [.orientation])
        XCTAssertTrue(module.state.isEmpty)
        let received = await bufferedEvents(events)
        XCTAssertEqual(received, [.stateRefresh("sensors")])
        module.configure(root: nil)
    }

    func testSharedShakeFixtureEmitsOnlyEmptyEventsAtExpectedTimes() async throws {
        let fixture = try fixture("shake-cooldown", as: SensorShakeFixture.self)
        let source = SensorSource()
        let clock = SensorClock()
        let module = module(source, clock: clock)
        module.configure(root: block(.shake))
        var shakes: [Int] = []
        for sample in fixture.samples {
            let stream = module.events
            clock.monotonicMilliseconds = sample.timestampMs
            source.report(.shake, .acceleration(x: sample.x, y: sample.y, z: sample.z))
            let events = await bufferedEvents(stream)
            if !events.isEmpty {
                XCTAssertEqual(events, [PlatformEvent(event: "sensors.shake", data: .object([:]))])
                shakes.append(sample.timestampMs)
            }
        }
        XCTAssertEqual(shakes, fixture.expectedShakes)
        XCTAssertTrue(module.state.isEmpty)
        module.configure(root: nil)
    }

    func testOnlyDeclaredAvailableSensorsStartAndStepsNeedUsageAndPermission() {
        for hasUsage in [false, true] {
            for available in [false, true] {
                for allowed in [false, true] {
                    let source = SensorSource()
                    source.stepsAllowed = allowed
                    if !available { source.available.remove(.steps) }
                    let module = PrototypeSensorsModule(
                        source: source, bundle: SensorBundle(hasMotionUsage: hasUsage), clock: SensorClock()
                    )
                    module.configure(root: block(.steps))
                    XCTAssertEqual(source.starts.map(\.sensor), hasUsage && available && allowed ? [.steps] : [])
                    source.report(.steps, .values(["steps": 5]))
                    XCTAssertEqual(module.state["steps"], hasUsage && available && allowed ? .number(5) : nil)
                    XCTAssertFalse(source.queries.contains(.orientation))
                    XCTAssertFalse(source.queries.contains(.shake))
                    module.configure(root: nil)
                }
            }
        }
        let source = SensorSource()
        source.available = []
        let module = module(source)
        module.configure(root: block(.orientation, .shake, .proximity))
        XCTAssertTrue(source.starts.isEmpty)
        XCTAssertTrue(module.state.isEmpty)
        module.configure(root: nil)
    }

    func testProximityPublishesEveryDistinctEdgeWithoutThrottle() async {
        let source = SensorSource()
        let clock = SensorClock()
        let module = module(source, clock: clock)
        module.configure(root: block(.proximity))
        let stream = module.events
        source.report(.proximity, .proximity(false))
        clock.monotonicMilliseconds = 200
        source.report(.proximity, .proximity(true))
        source.report(.proximity, .proximity(true))
        XCTAssertEqual(module.state["proximityNear"], .bool(true))
        source.report(.proximity, .proximity(false))
        XCTAssertEqual(module.state["proximityNear"], .bool(false))
        let received = await bufferedEvents(stream)
        XCTAssertEqual(received, Array(repeating: .stateRefresh("sensors"), count: 3))
        module.configure(root: nil)
    }

    func testStopClearsStateAndDropsSynchronousAndLateCallbacksWithoutEvents() async {
        let source = SensorSource()
        let module = module(source)
        module.configure(root: block(.orientation, .proximity, .shake, .steps))
        let old = source.handlers
        source.report(.orientation, .values(["pitchDeg": 3]))
        XCTAssertEqual(module.state["pitchDeg"], .number(3))
        let stream = module.events
        source.duringStop = { old[.shake]?(.acceleration(x: 30, y: 0, z: 0)) }
        let stops = source.stops
        module.configure(root: nil)
        XCTAssertEqual(source.stops, stops + 1)
        XCTAssertTrue(source.handlers.isEmpty)
        XCTAssertTrue(module.state.isEmpty)
        old[.orientation]?(.values(["pitchDeg": 90]))
        old[.proximity]?(.proximity(true))
        old[.steps]?(.values(["steps": 20]))
        old[.shake]?(.acceleration(x: 30, y: 0, z: 0))
        XCTAssertTrue(module.state.isEmpty)
        let received = await bufferedEvents(stream)
        XCTAssertEqual(received, [.stateRefresh("sensors")])
    }

    func testChangedBlockResetsFiltersAndShakesAndRejectsOldSession() async {
        let source = SensorSource()
        let clock = SensorClock()
        let module = module(source, clock: clock)
        let original = block(.orientation, .shake, .steps)
        module.configure(root: original)
        source.report(.orientation, .values(["pitchDeg": 1]))
        source.report(.steps, .values(["steps": 10]))
        source.report(.shake, .acceleration(x: 30, y: 0, z: 0))
        let old = source.handlers
        let starts = source.starts.count
        let stops = source.stops
        module.configure(root: original)
        XCTAssertEqual(source.starts.count, starts, "An unchanged block preserves its subscription")
        XCTAssertEqual(source.stops, stops)
        module.configure(root: .object([
            "orientation": .object(["rateHz": .number(30)]), "shake": .object([:]), "steps": .object([:]),
        ]))
        XCTAssertEqual(source.stops, stops + 1)
        XCTAssertTrue(module.state.isEmpty)
        let stream = module.events
        clock.monotonicMilliseconds = 1
        old[.orientation]?(.values(["pitchDeg": 99]))
        old[.steps]?(.values(["steps": 999]))
        old[.shake]?(.acceleration(x: 30, y: 0, z: 0))
        XCTAssertTrue(module.state.isEmpty)
        source.report(.orientation, .values(["pitchDeg": 1]))
        source.report(.steps, .values(["steps": 2]))
        source.report(.shake, .acceleration(x: 30, y: 0, z: 0))
        XCTAssertEqual(module.state["pitchDeg"], .number(1))
        XCTAssertEqual(module.state["steps"], .number(2), "The source already counts from the new start date")
        let received = await bufferedEvents(stream)
        XCTAssertEqual(received, [
            .stateRefresh("sensors"), .stateRefresh("sensors"),
            PlatformEvent(event: "sensors.shake", data: .object([:])),
        ])
        module.configure(root: nil)
    }

    func testIdenticalBlockInNewShowSessionResetsStepsFiltersAndShakeCooldown() async throws {
        // Exercise the UIKit-free session with the same tokens supplied by PrototypeModel.show.
        let url = PrototypeSpecFixtures.directory.appendingPathComponent("valid/sensors-block-rates.json")
        let fixture = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url))
        for reset in [false, true] {
            var fields = try XCTUnwrap(fixture.objectFields)
            fields["id"] = .string("A")
            let firstSpec = try JSONDecoder().decode(PrototypeSpec.self, from: JSONEncoder().encode(fields))
            fields["id"] = .string(reset ? "A" : "B")
            let nextSpec = try JSONDecoder().decode(PrototypeSpec.self, from: JSONEncoder().encode(fields))
            var session = PrototypeSession()
            session.show(firstSpec)
            let source = SensorSource()
            let clock = SensorClock()
            let registry = PrototypePlatformRegistry(modules: [module(source, clock: clock)])
            let original = try XCTUnwrap(firstSpec.sensorsBlock)
            XCTAssertEqual(nextSpec.sensorsBlock, original)
            registry.configure(sensorsBlock: original, sessionID: 1)
            source.report(.orientation, .values(["pitchDeg": 1]))
            source.report(.steps, .values(["steps": 10]))
            source.report(.shake, .acceleration(x: 30, y: 0, z: 0))
            let old = source.handlers
            source.duringStop = {
                old[.steps]?(.values(["steps": 999]))
                old[.shake]?(.acceleration(x: 30, y: 0, z: 0))
            }
            registry.configure(sensorsBlock: nextSpec.sensorsBlock, sessionID: 2)
            try session.show(nextSpec.replacingPlatform(registry.snapshot), reset: reset)
            XCTAssertEqual(session.spec?.id, reset ? "A" : "B")
            XCTAssertEqual(session.spec?.platformState["sensors"], .object([:]))
            let stream = registry.modules["sensors"]?.events
            clock.monotonicMilliseconds = 1
            old[.orientation]?(.values(["pitchDeg": 99]))
            old[.steps]?(.values(["steps": 999]))
            old[.shake]?(.acceleration(x: 30, y: 0, z: 0))
            XCTAssertEqual(registry.snapshot["sensors"], .object([:]))
            source.report(.orientation, .values(["pitchDeg": 1]))
            source.report(.steps, .values(["steps": 2]))
            source.report(.shake, .acceleration(x: 30, y: 0, z: 0))
            XCTAssertEqual(registry.snapshot["sensors"]?.objectFields?["steps"], .number(2))
            guard let stream else { return XCTFail("Missing sensor stream") }
            let received = await bufferedEvents(stream)
            XCTAssertEqual(received, [
                .stateRefresh("sensors"), .stateRefresh("sensors"),
                PlatformEvent(event: "sensors.shake", data: .object([:])),
            ])
            registry.configure(sensorsBlock: nil)
        }
    }

    func testIdenticalBlockInSameSessionPreservesSubscriptionAndState() {
        let source = SensorSource()
        let registry = PrototypePlatformRegistry(modules: [module(source)])
        let original = block(.steps, .shake)
        registry.configure(sensorsBlock: original, sessionID: 7)
        source.report(.steps, .values(["steps": 10]))
        let starts = source.starts.count
        let stops = source.stops
        registry.configure(sensorsBlock: original, sessionID: 7)
        XCTAssertEqual(source.starts.count, starts)
        XCTAssertEqual(source.stops, stops)
        XCTAssertEqual(registry.snapshot["sensors"]?.objectFields?["steps"], .number(10))
        registry.configure(sensorsBlock: nil)
    }

    func testNewSessionDropsBufferedSensorEventsAndKeepsSharedStatusRunning() async {
        let source = SensorSource()
        let statusSource = FakeDeviceStatusSource(["value": .number(0)])
        let clock = LocationClock()
        let registry = PrototypePlatformRegistry(modules: [
            module(source), PrototypeDeviceStatusModule.battery(source: statusSource, clock: clock),
        ])
        let driver = PrototypePlatformDriver(registry: registry, clock: clock)
        registry.configure(sensorsBlock: block(.shake), sessionID: 1)
        driver.subscribe()
        var delivered: [PlatformEvent] = []
        driver.onEvent = { delivered.append($0) }
        await withCheckedContinuation { ready in
            var resumed = false
            driver.onState = { snapshot in
                if !resumed, snapshot["sensors"]?.objectFields?["pitchDeg"] == .number(1) {
                    resumed = true
                    ready.resume()
                }
            }
            source.report(.shake, .acceleration(x: 30, y: 0, z: 0))
            driver.resetSessionEvents()
            registry.configure(sensorsBlock: block(.orientation), sessionID: 2)
            driver.subscribe()
            source.report(.orientation, .values(["pitchDeg": 1]))
        }
        XCTAssertTrue(delivered.isEmpty, "The old buffered shake must not reach the new session")
        XCTAssertEqual(statusSource.starts, 1)
        XCTAssertEqual(statusSource.stops, 0)
        driver.stopEvents()
        XCTAssertEqual(statusSource.stops, 1)
    }

    func testSharedRegistryPresentationsKeepSensorStateEventsAndTeardownIndependent() async throws {
        for dismissFirst in [true, false] {
            let source = SensorSource()
            let clock = LocationClock()
            let shared = PrototypePlatformRegistry(modules: [module(source)])
            let first = shared.forPresentation()
            let second = shared.forPresentation()
            let firstSource = try XCTUnwrap(source.presentations.first)
            let secondSource = try XCTUnwrap(source.presentations.last)
            XCTAssertFalse(firstSource === secondSource)
            let firstDriver = PrototypePlatformDriver(registry: first, clock: clock)
            let secondDriver = PrototypePlatformDriver(registry: second, clock: clock)
            firstDriver.subscribe()
            first.configure(sensorsBlock: block(.steps, .shake), sessionID: 1)
            firstSource.report(.steps, .values(["steps": 4]))
            let stops = firstSource.stops
            secondDriver.subscribe()
            second.configure(sensorsBlock: block(.orientation), sessionID: 1)
            XCTAssertEqual(firstSource.stops, stops, "Showing B must not restart A")
            XCTAssertNotNil(firstSource.handlers[.steps])
            let firstStream = try XCTUnwrap(first.modules["sensors"]).events
            let secondStream = try XCTUnwrap(second.modules["sensors"]).events
            firstSource.report(.shake, .acceleration(x: 30, y: 0, z: 0))
            secondSource.report(.orientation, .values(["pitchDeg": 8]))
            XCTAssertEqual(first.snapshot["sensors"]?.objectFields?["steps"], .number(4))
            XCTAssertNil(first.snapshot["sensors"]?.objectFields?["pitchDeg"])
            XCTAssertNil(second.snapshot["sensors"]?.objectFields?["steps"])
            let firstEvents = await bufferedEvents(firstStream)
            let secondEvents = await bufferedEvents(secondStream)
            XCTAssertEqual(firstEvents, [PlatformEvent(event: "sensors.shake", data: .object([:]))])
            XCTAssertEqual(secondEvents, [.stateRefresh("sensors")])
            if dismissFirst {
                first.configure(sensorsBlock: nil)
                firstDriver.stopEvents()
                secondSource.report(.orientation, .values(["rollDeg": 9]))
                XCTAssertEqual(second.snapshot["sensors"]?.objectFields?["rollDeg"], .number(9))
                secondDriver.stopEvents()
            } else {
                second.configure(sensorsBlock: nil)
                secondDriver.stopEvents()
                firstSource.report(.steps, .values(["steps": 5]))
                XCTAssertEqual(first.snapshot["sensors"]?.objectFields?["steps"], .number(5))
                firstDriver.stopEvents()
            }
            XCTAssertTrue(firstSource.handlers.isEmpty)
            XCTAssertTrue(secondSource.handlers.isEmpty)
        }
    }

    func testContinuousKeysHaveIndependentWindowsAndIgnoreInvalidOrForeignValues() {
        let source = SensorSource()
        let clock = SensorClock()
        let module = module(source, clock: clock)
        module.configure(root: block(.orientation, .steps))
        source.report(.orientation, .values(["pitchDeg": -1.5, "rollDeg": -200, "steps": 99]))
        XCTAssertEqual(module.state, ["pitchDeg": .number(-1), "rollDeg": .number(-180)])
        clock.monotonicMilliseconds = 200
        source.report(.orientation, .values(["pitchDeg": 20, "headingDeg": 360]))
        XCTAssertEqual(module.state["pitchDeg"], .number(-1))
        XCTAssertEqual(module.state["headingDeg"], .number(0))
        clock.monotonicMilliseconds = 1000
        source.report(.orientation, .values(["pitchDeg": .nan, "rollDeg": .infinity]))
        source.report(.orientation, .values(["pitchDeg": 20]))
        XCTAssertEqual(module.state["pitchDeg"], .number(20))
        source.report(.steps, .values(["steps": -1]))
        XCTAssertEqual(module.state["steps"], .number(0))
        clock.monotonicMilliseconds = 1200
        source.report(.steps, .values(["steps": 5]))
        XCTAssertEqual(module.state["steps"], .number(0))
        clock.monotonicMilliseconds = 2000
        source.report(.steps, .values(["steps": 5]))
        XCTAssertEqual(module.state["steps"], .number(5))
        source.stepsAllowed = false
        clock.monotonicMilliseconds = 3000
        source.report(.steps, .values(["steps": 10]))
        XCTAssertEqual(module.state["steps"], .number(5))
        module.configure(root: nil)
    }

    func testShakeThresholdAndInvalidSamples() async {
        let source = SensorSource()
        let module = module(source)
        module.configure(root: block(.shake))
        let stream = module.events
        source.report(.shake, .acceleration(x: .nan, y: 0, z: 0))
        source.report(.shake, .acceleration(x: .infinity, y: 0, z: 0))
        source.report(.shake, .acceleration(x: 0, y: 0, z: 2.69 * 9.80665))
        source.report(.shake, .acceleration(x: 0, y: 0, z: 2.7 * 9.80665))
        let received = await bufferedEvents(stream)
        XCTAssertEqual(received, [PlatformEvent(event: "sensors.shake", data: .object([:]))])
        module.configure(root: nil)
    }

    func testRawBlockSurvivesDecodeAndSpecCopies() throws {
        let url = PrototypeSpecFixtures.directory.appendingPathComponent("valid/sensors-block-rates.json")
        let spec = try JSONDecoder().decode(PrototypeSpec.self, from: Data(contentsOf: url))
        let expected = JSONValue.object([
            "orientation": .object(["rateHz": .number(1)]), "light": .object(["rateHz": .number(30)]),
            "proximity": .object([:]), "steps": .object([:]), "shake": .object([:]),
        ])
        XCTAssertEqual(spec.sensorsBlock, expected)
        XCTAssertEqual(try spec.replacingPlatform([:]).sensorsBlock, expected)
        let source = SensorSource()
        let module = module(source)
        module.configure(root: spec.sensorsBlock)
        XCTAssertEqual(Set(source.starts.map(\.sensor)), [.orientation, .proximity, .steps, .shake])
        XCTAssertEqual(source.starts.first { $0.sensor == .orientation }?.rate, 1)
        module.configure(root: nil)
    }

    func testBothProductionFactoriesAdvertiseOnlyWhenSourceSupplied() {
        let services = SensorRegistryServices()
        for supplied in [false, true] {
            for hasUsage in [false, true] {
                let source = SensorSource()
                let sensors: (any PrototypeSensorSource)? = supplied ? source : nil
                let registries = [
                    PrototypePlatformRegistry.feedbackModules(
                        haptics: services, sound: services, connectivity: services, links: services, settings: services,
                        bundle: SensorBundle(hasMotionUsage: hasUsage), sensors: sensors
                    ),
                    PrototypePlatformRegistry.systemModules(
                        clipboard: FakePrototypeClipboard(), connectivity: services, links: services,
                        settings: services,
                        bundle: SensorBundle(hasMotionUsage: hasUsage), sensors: sensors
                    ),
                ]
                for registry in registries {
                    XCTAssertEqual(registry.capabilities.contains("prototype_platform_sensors_v1"), supplied)
                    XCTAssertEqual(PrototypeAgentProtocol.advertisedCapabilities(
                        registryCapabilities: registry.capabilities
                    ).contains("prototype_platform_sensors_v1"), supplied)
                    registry.configure(sensorsBlock: block(.orientation))
                    source.report(.orientation, .values(["pitchDeg": 7]))
                    XCTAssertEqual(registry.snapshot["sensors"], supplied ? .object(["pitchDeg": .number(7)]) : nil)
                    registry.configure(sensorsBlock: nil)
                    XCTAssertEqual(registry.snapshot["sensors"], supplied ? .object([:]) : nil)
                }
            }
        }
    }
}
