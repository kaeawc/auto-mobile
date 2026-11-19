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
    var availabilityChecks = 0
    var calls = 0
    private let echo = PrototypeTestPlatformModule()
    var state: [String: JSONValue] = [:]
    let events: AsyncStream<PlatformEvent>
    let continuation: AsyncStream<PlatformEvent>.Continuation
    init() { (events, continuation) = AsyncStream.makeStream(bufferingPolicy: .bufferingNewest(16)) }
    func availability() -> PlatformAvailability {
        availabilityChecks += 1
        return .ready
    }

    func call(_ call: PlatformCall) async -> PlatformCallResult {
        calls += 1
        return await echo.call(call)
    }

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
    private struct RefusalCase {
        let id: String
        let event: String
        let data: JSONValue
        let session: PrototypeSession
        let hint: String
    }

    private func fixture<Value: Decodable>(_ name: String, as _: Value.Type) throws -> Value {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test/fixtures/prototype-spec/platform-simulation/\(name).json")
        return try JSONDecoder().decode(Value.self, from: Data(contentsOf: url))
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
        session.show(spec)
        return session
    }

    @MainActor
    func testSharedFixtureUsesRealDeliveryAndStatePath() async throws {
        let fixture = try fixture("test-tick", as: [String: JSONValue].self)
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
    func testSimulationAcceptsHostByteLimitWithSmallExponent() throws {
        let emptyData = JSONValue.object(["x": .number(1e-7), "text": .string("")])
        let emptyPayload = JSONValue.object([
            "event": .string("test.tick"), "data": emptyData, "simulated": .bool(true),
        ])
        let overhead = try XCTUnwrap(PrototypeEmitContext.jsonByteCount(emptyPayload))
        let text = String(repeating: "a", count: PrototypeLimits.maxEmitPayloadBytes - overhead)
        let data = JSONValue.object(["x": .number(1e-7), "text": .string(text)])
        let payload = JSONValue.object([
            "event": .string("test.tick"), "data": data, "simulated": .bool(true),
        ])
        XCTAssertEqual(PrototypeEmitContext.jsonByteCount(payload), 4096)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        XCTAssertGreaterThan(try encoder.encode(payload).count, 4096)

        let module = SimulationModule()
        let registry = PrototypePlatformRegistry(modules: [module])
        var current = try session()
        var delivered: [PlatformEvent] = []
        XCTAssertNil(PrototypePlatformSimulation.apply(
            id: "p", event: "test.tick", data: data, session: current, registry: registry
        ) { delivered.append($0) })
        XCTAssertEqual(module.mutations, 1)
        XCTAssertEqual(module.state, data.objectFields)
        XCTAssertEqual(delivered.count, 1)
        let event = try XCTUnwrap(delivered.first)
        let emitted = try current.deliverPlatformEvent(event.event, data: event.data, simulated: true)
        let emittedPayload = try XCTUnwrap(emitted.first { $0.name == "prototype_platform_event" }?.payload)
        XCTAssertEqual(emittedPayload.objectFields?["data"], data)
        XCTAssertNil(emittedPayload.objectFields?["truncated"])
        XCTAssertEqual(emittedPayload.objectFields?["simulated"], .bool(true))

        delivered = []
        let oversized = JSONValue.object(["x": .number(1e-7), "text": .string(text + "a")])
        let refusal = PrototypePlatformSimulation.apply(
            id: "p", event: "test.tick", data: oversized, session: current, registry: registry
        ) { delivered.append($0) }
        XCTAssertTrue(refusal?.contains("4096-byte") == true, refusal ?? "accepted")
        XCTAssertTrue(delivered.isEmpty)
        XCTAssertEqual(module.mutations, 1)
        XCTAssertEqual(module.state, data.objectFields)
    }

    @MainActor
    func testRefusalsPrecedeMutationAndDelivery() throws {
        let module = SimulationModule()
        let registry = PrototypePlatformRegistry(modules: [module])
        let shown = try session()
        var inactive = shown
        _ = inactive.dismiss(reason: .agent)
        let cases: [RefusalCase] = try [
            .init(id: "p", event: "test.missing", data: .object([:]), session: shown, hint: "Unknown"),
            .init(id: "p", event: "missing.tick", data: .object([:]), session: shown, hint: "Unknown"),
            .init(
                id: "p",
                event: "test.tick",
                data: .object([:]),
                session: session(declared: false),
                hint: "requires.platform"
            ),
            .init(
                id: "p",
                event: "test.tick",
                data: .object(["text": .string(String(repeating: "😀", count: 1024))]),
                session: shown,
                hint: "4096-byte"
            ),
            .init(id: "p", event: "test.tick", data: .array([]), session: shown, hint: "JSON object"),
            .init(id: "p", event: "test.tick", data: .null, session: shown, hint: "JSON object"),
            .init(id: "other", event: "test.tick", data: .object([:]), session: shown, hint: "inactive"),
            .init(id: "p", event: "test.tick", data: .object([:]), session: inactive, hint: "inactive"),
        ]
        for refusal in cases {
            let error = PrototypePlatformSimulation.apply(
                id: refusal.id,
                event: refusal.event,
                data: refusal.data,
                session: refusal.session,
                registry: registry
            ) { _ in XCTFail("refused event delivered") }
            XCTAssertTrue(error?.contains(refusal.hint) == true, error ?? "accepted")
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
        let simulationCommands = [
            PrototypeAgentProtocol.platformSimulationCapability, PrototypeAgentProtocol.simulatePlatformRequest,
            PrototypeAgentProtocol.platformOutcomesCapability, PrototypeAgentProtocol.queueCallOutcomeRequest,
        ]
        XCTAssertTrue(Set(PrototypeAgentProtocol.capabilities).isDisjoint(with: simulationCommands))
        let production = PrototypePlatformRegistry(modules: [NoSimulationModule()])
        XCTAssertFalse(production.supportsSimulation)
        XCTAssertTrue(Set(production.capabilities).isDisjoint(with: simulationCommands))
        let base = PrototypePlatformRegistry()
        for environment in [[:], [PrototypeTestHooks.environmentKey: "0"]] {
            let registry = base.withTestHooks(environment: environment)
            XCTAssertNil(registry.modules["test"])
            XCTAssertTrue(Set(registry.capabilities).isDisjoint(with: simulationCommands))
        }
        let enabled = base.withTestHooks(environment: [PrototypeTestHooks.environmentKey: "1"])
        XCTAssertTrue(enabled.modules["test"] is PrototypeTestPlatformModule)
        XCTAssertTrue(enabled.supportsSimulation)
        for supported in simulationCommands {
            XCTAssertTrue(enabled.capabilities.contains(supported))
            XCTAssertTrue(
                PrototypeAgentProtocol.advertisedCapabilities(registryCapabilities: enabled.capabilities)
                    .contains(supported)
            )
        }
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

extension PrototypePlatformSimulationTests {
    @MainActor
    private func echo(
        _ driver: PrototypePlatformDriver,
        call: String = "test.echo",
        args: [String: JSONValue] = ["message": .string("real")]
    )
        async -> PlatformCallResult?
    {
        var result: PlatformCallResult?
        driver.onComplete = { _, value, _ in result = value }
        driver.perform([.start(.init(call: .init(callId: "echo", call: call, args: args), timeoutMs: 100))])
        await driver.settled()
        return result
    }

    @MainActor
    func testSharedCallOutcomeFixtureBypassesAvailabilityAndUsesOrdinaryCompletion() async throws {
        let steps = try fixture("test-echo-outcomes", as: [[String: JSONValue]].self)
        let module = SimulationModule()
        let clock = ManualRequestClock()
        let driver = PrototypePlatformDriver(registry: PrototypePlatformRegistry(modules: [module]), clock: clock)
        let shown = try session()
        var revisions = 0
        driver.onState = { _ in revisions += 1 }
        var completions = 0
        for step in steps {
            if let outcome = step["queue"] {
                XCTAssertNil(driver.queueCallOutcome(id: "p", call: "test.echo", outcome: outcome, session: shown))
                continue
            }
            let call = try XCTUnwrap(step["call"]?.stringValue)
            let args = try XCTUnwrap(step["args"]?.objectFields)
            let expected = try XCTUnwrap(step["expected"]?.objectFields)
            let result = await echo(driver, call: call, args: args)
            completions += 1
            if let value = expected["result"] {
                XCTAssertEqual(result, .success(value))
            } else {
                let error = try XCTUnwrap(expected["error"]?.objectFields)
                let code = try XCTUnwrap(PlatformErrorCode(rawValue: error["code"]?.stringValue ?? ""))
                XCTAssertEqual(result, try .failure(code, XCTUnwrap(error["message"]?.stringValue)))
            }
            let realCalls = expected["result"] == .string("real") ? 1 : 0
            XCTAssertEqual(module.availabilityChecks, realCalls)
            XCTAssertEqual(module.calls, realCalls)
            XCTAssertEqual(revisions, completions)
            XCTAssertTrue(clock.live.isEmpty)
        }
    }

    @MainActor
    func testInvalidArgsAndOtherCallsLeaveQueueUntouchedAndResetClearsIt() async throws {
        let module = SimulationModule()
        let driver = PrototypePlatformDriver(
            registry: PrototypePlatformRegistry(modules: [module]), clock: ManualRequestClock()
        )
        let shown = try session()
        let outcome = JSONValue.object(["result": .null])
        for call in ["test.protected", "test.echo"] {
            XCTAssertNil(driver.queueCallOutcome(id: "p", call: call, outcome: outcome, session: shown))
        }
        let invalid = await echo(driver, args: ["bogus": .number(1)])
        XCTAssertEqual(invalid, .failure(.invalidArgs, "Unknown argument: bogus"))
        let scripted = await echo(driver)
        XCTAssertEqual(scripted, .success(.null))
        XCTAssertEqual(module.calls, 0)
        let fallback = await echo(driver)
        XCTAssertEqual(fallback, .success(.string("real")))
        XCTAssertEqual(module.calls, 1)
        XCTAssertNil(driver.queueCallOutcome(id: "p", call: "test.echo", outcome: outcome, session: shown))
        driver.clearOutcomes()
        let afterReset = await echo(driver)
        XCTAssertEqual(afterReset, .success(.string("real")))
        XCTAssertEqual(module.calls, 2)
    }

    @MainActor
    func testCallOutcomeRefusalsPrecedeMutationAndQueueCapIsPerCall() async throws {
        let driver = PrototypePlatformDriver(
            registry: PrototypePlatformRegistry(modules: [SimulationModule()]), clock: ManualRequestClock()
        )
        let shown = try session()
        var inactive = shown
        _ = inactive.dismiss(reason: .agent)
        let outcome = JSONValue.object(["result": .null])
        let cases: [(String, String, PrototypeSession, String)] = try [
            ("other", "test.echo", shown, "inactive"),
            ("p", "test.echo", inactive, "inactive"),
            ("p", "test.missing", shown, "Unknown platform call"),
            ("p", "test.echo", session(declared: false), "requires.platform"),
        ]
        for (id, call, session, hint) in cases {
            let error = driver.queueCallOutcome(id: id, call: call, outcome: outcome, session: session)
            XCTAssertTrue(error?.contains(hint) == true, error ?? "accepted")
        }
        for (registry, hint) in [
            (PrototypePlatformRegistry.empty, "No module registered"),
            (PrototypePlatformRegistry(modules: [NoSimulationModule()]), "does not support simulation"),
        ] {
            let other = PrototypePlatformDriver(registry: registry, clock: ManualRequestClock())
            let error = other.queueCallOutcome(id: "p", call: "test.echo", outcome: outcome, session: shown)
            XCTAssertTrue(error?.contains(hint) == true, error ?? "accepted")
        }
        for invalid in [
            JSONValue.object([:]),
            .object(["result": .string(String(repeating: "😀", count: 1024))]),
            .object(["error": .object(["code": .string("unknown")])]),
        ] {
            XCTAssertNotNil(driver.queueCallOutcome(id: "p", call: "test.echo", outcome: invalid, session: shown))
        }
        for _ in 0 ..< 16 {
            XCTAssertNil(driver.queueCallOutcome(id: "p", call: "test.echo", outcome: outcome, session: shown))
        }
        XCTAssertTrue(driver.queueCallOutcome(
            id: "p", call: "test.echo", outcome: outcome, session: shown
        )?.contains("At most 16") == true)
        XCTAssertNil(driver.queueCallOutcome(id: "p", call: "test.protected", outcome: outcome, session: shown))
        let consumed = await echo(driver)
        XCTAssertEqual(consumed, .success(.null))
        XCTAssertNil(driver.queueCallOutcome(id: "p", call: "test.echo", outcome: outcome, session: shown))
    }
}
