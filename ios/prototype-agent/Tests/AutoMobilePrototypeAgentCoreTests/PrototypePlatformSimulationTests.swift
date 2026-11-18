@testable import AutoMobilePrototypeAgentCore
import Foundation
import XCTest

private final class SimulationTimer: PrototypeTimerHandle {
    func cancel() {}
}

private final class SimulationClock: PrototypeClock {
    var nowMilliseconds = 0
    func schedule(afterMilliseconds _: Int, _: @escaping () -> Void) -> any PrototypeTimerHandle {
        XCTFail("Event injection must not schedule work")
        return SimulationTimer()
    }
}

@MainActor
private final class SimulationModule: PrototypePlatformModule {
    let name = "test"
    let capability = "prototype_platform_test_v1"
    var supportsSimulation = true
    var accepts = true
    var mutations = 0
    var state: [String: JSONValue] = [:]
    let events: AsyncStream<PlatformEvent>
    let continuation: AsyncStream<PlatformEvent>.Continuation
    init() { (events, continuation) = AsyncStream.makeStream(bufferingPolicy: .bufferingNewest(16)) }
    func availability() -> PlatformAvailability { .ready }
    func call(_: PlatformCall) async -> PlatformCallResult { .failure(.unsupported, "unused") }
    func simulate(_ event: PlatformEvent) -> Bool {
        guard accepts else { return false }
        mutations += 1
        state = event.data.objectFields ?? [:]
        return true
    }

    func tick(_ data: JSONValue) {
        state = data.objectFields ?? [:]
        continuation.yield(PlatformEvent(event: "test.tick", data: data))
    }
}

@MainActor
private final class NoSimulationModule: PrototypePlatformModule {
    let name = "test"
    let capability = "prototype_platform_test_v1"
    let state: [String: JSONValue] = [:]
    let events = AsyncStream<PlatformEvent> { $0.finish() }
    func availability() -> PlatformAvailability { .ready }
    func call(_: PlatformCall) async -> PlatformCallResult { .failure(.unsupported, "unused") }
}

final class PrototypePlatformSimulationTests: XCTestCase {
    private func fixture() throws -> [String: JSONValue] {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test/fixtures/prototype-spec/platform-simulation/test-tick.json")
        return try JSONDecoder().decode([String: JSONValue].self, from: Data(contentsOf: url))
    }

    private func session(declared: Bool = true) throws -> PrototypeSession {
        let declaration = declared ?
            #", "requires":{"platform":["test"]}, "platform":{"on":{"test.tick":[{"type":"setData","path":"/data/tick","value":{"event":"/count"}},{"type":"setData","path":"/data/fromPlatform","value":{"platform":"/test/count"}}]}}"# :
            ""
        let spec = try JSONDecoder().decode(PrototypeSpec.self, from: Data("""
        {"id":"p","window":{"placement":{"type":"fullscreen"}},"data":{"tick":0,"fromPlatform":0},"root":{"type":"text","text":"tick"}\(
            declaration
        )}
        """.utf8))
        var session = PrototypeSession()
        try session.show(spec)
        return session
    }

    @MainActor
    func testSharedFixtureUsesRealDeliveryAndStatePath() async throws {
        let fixture = try fixture()
        let data = try XCTUnwrap(fixture["data"])
        let eventName = try XCTUnwrap(fixture["event"]?.stringValue)
        let module = SimulationModule()
        let driver = PrototypePlatformDriver(
            registry: PrototypePlatformRegistry(modules: [module]),
            clock: SimulationClock()
        )
        var current = try session()
        var emitted: [PrototypeEvent] = []
        driver.onState = { snapshot in
            do { try current.setPlatformState(snapshot) }
            catch { XCTFail("\(error)") }
        }
        driver.onEvent = { event in
            do { emitted += try current.deliverPlatformEvent(event.event, data: event.data, simulated: event.simulated)
            } catch { XCTFail("\(error)") }
        }
        let original = current
        XCTAssertNil(driver.simulate(id: "p", event: eventName, data: data, session: current))
        XCTAssertEqual(module.mutations, 1)
        XCTAssertEqual(emitted.filter { $0.name == "prototype_platform_event" }.count, 1)
        let simulated = try XCTUnwrap(emitted.first { $0.name == "prototype_platform_event" })
        XCTAssertEqual(simulated.payload, fixture["expected"])
        let simulatedState = current.spec?.platformState
        let simulatedData = current.spec?.data
        current = original
        emitted = []
        let deliver = driver.onEvent
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            driver.onEvent = { event in
                deliver?(event)
                continuation.resume()
            }
            driver.subscribe()
            module.tick(data)
        }
        driver.stopEvents()
        let real = try XCTUnwrap(emitted.first { $0.name == "prototype_platform_event" })
        XCTAssertNil(real.payload.objectFields?["simulated"])
        var expected = try XCTUnwrap(simulated.payload.objectFields)
        expected.removeValue(forKey: "simulated")
        XCTAssertEqual(real.payload, .object(expected))
        XCTAssertEqual(current.spec?.platformState, simulatedState)
        XCTAssertEqual(current.spec?.data, simulatedData)
        XCTAssertEqual(current.spec?.data?["tick"], .number(7))
        XCTAssertEqual(current.spec?.data?["fromPlatform"], .number(7))
    }

    @MainActor
    func testRefusalsPrecedeMutationAndDelivery() throws {
        let module = SimulationModule()
        let registry = PrototypePlatformRegistry(modules: [module])
        let shown = try session()
        var inactive = shown
        _ = inactive.dismiss(reason: .agent)
        let cases: [(String, String, JSONValue, PrototypeSession, String)] = try [
            ("p", "test.missing", .object([:]), shown, "Unknown"),
            ("p", "missing.tick", .object([:]), shown, "Unknown"),
            ("p", "test.tick", .object([:]), session(declared: false), "requires.platform"),
            ("p", "test.tick", .object(["text": .string(String(repeating: "😀", count: 1024))]), shown, "4096-byte"),
            ("p", "test.tick", .array([]), shown, "JSON object"),
            ("p", "test.tick", .null, shown, "JSON object"),
            ("other", "test.tick", .object([:]), shown, "inactive"),
            ("p", "test.tick", .object([:]), inactive, "inactive"),
        ]
        for (id, event, data, session, hint) in cases {
            let error = PrototypePlatformSimulation.apply(
                id: id,
                event: event,
                data: data,
                session: session,
                registry: registry
            ) { _ in XCTFail("refused event delivered") }
            XCTAssertTrue(error?.contains(hint) == true, error ?? "accepted")
            XCTAssertEqual(module.mutations, 0)
            XCTAssertEqual(module.state, [:])
        }
        module.accepts = false
        XCTAssertTrue(PrototypePlatformSimulation.apply(
            id: "p",
            event: "test.tick",
            data: .object([:]),
            session: shown,
            registry: registry
        ) { _ in XCTFail("unsupported delivery") }?.contains("unsupported") == true)
        XCTAssertEqual(module.mutations, 0)
        let defaultModule = NoSimulationModule()
        XCTAssertFalse(defaultModule.simulate(PlatformEvent(event: "test.tick", data: .object([:]))))
        XCTAssertTrue(PrototypePlatformSimulation.apply(
            id: "p",
            event: "test.tick",
            data: .object([:]),
            session: shown,
            registry: PrototypePlatformRegistry(modules: [defaultModule])
        ) { _ in XCTFail("default delivery") }?.contains("unsupported") == true)
        XCTAssertEqual(defaultModule.state, [:])
    }

    @MainActor
    func testRegistryOptInAndLaunchHooks() {
        let capability = PrototypeAgentProtocol.platformSimulationCapability
        XCTAssertFalse(PrototypeAgentProtocol.capabilities.contains(capability))
        let production = PrototypePlatformRegistry(modules: [NoSimulationModule()])
        XCTAssertFalse(production.supportsSimulation)
        XCTAssertFalse(production.capabilities.contains(capability))
        let base = PrototypePlatformRegistry()
        for environment in [[:], [PrototypeTestHooks.environmentKey: "0"]] {
            let registry = base.withTestHooks(environment: environment)
            XCTAssertNil(registry.modules["test"])
            XCTAssertFalse(registry.capabilities.contains(capability))
        }
        let enabled = base.withTestHooks(environment: [PrototypeTestHooks.environmentKey: "1"])
        XCTAssertTrue(enabled.modules["test"] is PrototypeTestPlatformModule)
        XCTAssertTrue(enabled.supportsSimulation)
        XCTAssertTrue(
            PrototypeAgentProtocol.advertisedCapabilities(registryCapabilities: enabled.capabilities)
                .contains(capability)
        )
    }

    @MainActor
    func testReferenceModuleEchoAndTick() async {
        let module = PrototypeTestPlatformModule()
        XCTAssertEqual(module.availability(), .ready)
        let echoed = await module.call(.init(callId: "1", call: "test.echo", args: ["message": .string("hello")]))
        XCTAssertEqual(echoed, .success(.string("hello")))
        let invalid = await module.call(.init(callId: "2", call: "test.echo", args: [:]))
        XCTAssertEqual(invalid, .failure(.invalidArgs, "message is required"))
        XCTAssertFalse(module.simulate(PlatformEvent(event: "test.unknown", data: .object([:]))))
        XCTAssertEqual(module.state, [:])
        XCTAssertTrue(module.simulate(PlatformEvent(event: "test.tick", data: .object(["count": .number(7)]))))
        XCTAssertEqual(module.state, ["count": .number(7)])
        var stream = module.events.makeAsyncIterator()
        let emitted = await stream.next()
        XCTAssertNil(emitted, "Simulation must not emit on the module stream")
    }

    func testTruncatedSimulationRetainsMarker() throws {
        var current = try session()
        let data = JSONValue.object(["text": .string(String(repeating: "😀", count: 1024))])
        let events = try current.deliverPlatformEvent("test.tick", data: data, simulated: true)
        XCTAssertEqual(
            events.first?.payload,
            .object(["event": .string("test.tick"), "data": .null, "truncated": .bool(true), "simulated": .bool(true)])
        )
    }
}
