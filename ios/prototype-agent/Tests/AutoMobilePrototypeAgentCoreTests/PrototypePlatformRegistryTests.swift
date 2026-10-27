@testable import AutoMobilePrototypeAgentCore
import XCTest

@MainActor
private final class FakePlatformModule: PrototypePlatformModule {
    let name = "test"
    let capability = "prototype_platform_test_v1"
    var requiredInfoPlistKeys: [String] = []
    var available: PlatformAvailability = .ready
    var state: [String: JSONValue] = ["n": .number(0)]
    let events: AsyncStream<PlatformEvent>
    let continuation: AsyncStream<PlatformEvent>.Continuation
    var received: [PlatformCall] = []
    var onCall: (() -> Void)?
    var result: PlatformCallResult?
    var suspended: CheckedContinuation<PlatformCallResult, Never>?

    init() {
        (events, continuation) = AsyncStream.makeStream(bufferingPolicy: .bufferingNewest(16))
    }

    func availability() -> PlatformAvailability { available }
    func call(_ call: PlatformCall) async -> PlatformCallResult {
        received.append(call)
        onCall?()
        if let result { return result }
        return await withCheckedContinuation { suspended = $0 }
    }

    func answer(_ result: PlatformCallResult) {
        suspended?.resume(returning: result)
        suspended = nil
    }
}

/// Reference test vocabulary only; production targets never register this module.
@MainActor
private final class TestPlatformModule: PrototypePlatformModule {
    let name = "test"
    let capability = "prototype_platform_test_v1"
    var state: [String: JSONValue] = ["lastEcho": .null]
    let events: AsyncStream<PlatformEvent>
    let continuation: AsyncStream<PlatformEvent>.Continuation
    init() { (events, continuation) = AsyncStream.makeStream(bufferingPolicy: .bufferingNewest(16)) }
    func availability() -> PlatformAvailability { .ready }
    func call(_ call: PlatformCall) async -> PlatformCallResult {
        let message = call.args["message"] ?? .null
        state["lastEcho"] = message
        continuation.yield(PlatformEvent(event: "test.tick", data: .object(["message": message])))
        return .success(message)
    }
}

@MainActor
private struct FakeBundleReader: PrototypeBundleReader {
    let keys: Set<String>
    func containsInfoPlistKey(_ key: String) -> Bool { keys.contains(key) }
}

private final class PlatformTimer: PrototypeTimerHandle {
    let fire: () -> Void
    var cancelled = false
    init(_ fire: @escaping () -> Void) { self.fire = fire }
    func cancel() { cancelled = true }
}

private final class PlatformClock: PrototypeClock {
    var nowMilliseconds = 0
    var timers: [PlatformTimer] = []
    func schedule(afterMilliseconds _: Int, _ fire: @escaping () -> Void) -> any PrototypeTimerHandle {
        let timer = PlatformTimer(fire)
        timers.append(timer)
        return timer
    }

    func expire() {
        nowMilliseconds += 10000
        for timer in timers where !timer.cancelled {
            timer.cancel(); timer.fire()
        }
    }
}

final class PrototypePlatformRegistryTests: XCTestCase {
    private func spec() throws -> PrototypeSpec {
        try JSONDecoder().decode(PrototypeSpec.self, from: Data("""
        {"id":"p","window":{"placement":{"type":"fullscreen"}},"requires":{"platform":["test"]},
        "state":{"status":"idle","n":0},"data":{},
        "platform":{"on":{"test.tick":[
          {"type":"increment","key":"n"},
          {"type":"setData","path":"/data/event","value":{"event":"/message"}},
          {"type":"platform","call":"test.echo","args":{"message":{"event":"/message"}},
           "onSuccess":[{"type":"setData","path":"/data/follow","value":{"event":"/message"}}]}
        ]}},"root":{"type":"text","text":"{platform:/test/lastEcho}"}}
        """.utf8))
    }

    private func action(_ extra: String = "") throws -> PrototypeAction {
        try JSONDecoder().decode(PrototypeAction.self, from: Data("""
        {"type":"platform","call":"test.echo","args":{"message":{"value":"hello"}},
         "into":"/data/result","statusKey":"status"\(extra)}
        """.utf8))
    }

    private func job(_ commands: [PrototypePlatformCommand]) throws -> PrototypePlatformJob {
        for command in commands {
            if case let .start(job) = command { return job }
        }
        throw XCTUnwrapError.missing
    }

    private enum XCTUnwrapError: Error { case missing }

    func testCompletionOrdering() throws {
        var session = PrototypeSession()
        try session.show(spec())
        let loading = try session.run([action(",\"onSuccess\":[{\"type\":\"emit\",\"name\":\"done\"}]")])
        XCTAssertEqual(loading.last?.state["status"], .string("loading"))
        let call = try job(session.takePlatformCommands()).call
        let events = session.completePlatformCall(call.callId, .success(.number(42)), durationMs: 7)
        XCTAssertEqual(
            events.map(\.name),
            ["/data/result", "/data/result__meta", "change", "prototype_platform", "done"]
        )
        XCTAssertEqual(events[0].state["status"], .string("loading"))
        XCTAssertEqual(events[2].state["status"], .string("success"))
        XCTAssertEqual(events[3].payload.objectFields?["callId"], .string(call.callId))
        XCTAssertEqual(events[3].payload.objectFields?["outcome"], .string("success"))
        XCTAssertEqual(session.data?["result__meta"]?.objectFields?["durationMs"], .number(7))
    }

    func testTypedFailureOrdering() throws {
        var session = PrototypeSession()
        try session.show(spec())
        _ = try session.run([action(",\"onError\":[{\"type\":\"emit\",\"name\":\"failed\"}]")])
        let id = try job(session.takePlatformCommands()).call.callId
        let events = session.completePlatformCall(id, .failure(.unavailable, "offline"), durationMs: 3)
        XCTAssertEqual(events.map(\.name), ["/data/result__meta", "change", "prototype_platform", "failed"])
        XCTAssertEqual(session.state["status"], .string("error"))
        XCTAssertNil(session.data?["result"])
    }

    func testErrorMessageRespectsHostUTF16Limit() throws {
        var session = PrototypeSession()
        try session.show(spec())
        _ = try session.run([action()])
        let id = try job(session.takePlatformCommands()).call.callId
        let events = session.completePlatformCall(
            id,
            .failure(.platformError, String(repeating: "🙂", count: 512)),
            durationMs: 0
        )
        let message = try XCTUnwrap(events.last?.payload.objectFields?["error"]?.objectFields?["message"]?.stringValue)
        XCTAssertEqual(message.utf16.count, 512)
    }

    func testDismissReplaceAndResetCancelWithoutLateWrites() throws {
        for reset in [false, true] {
            var session = PrototypeSession()
            try session.show(spec())
            _ = try session.run([action()])
            let id = try job(session.takePlatformCommands()).call.callId
            try session.show(spec(), reset: reset)
            let events = session.takePlatformLifecycleEvents()
            XCTAssertEqual(events.count, 1)
            XCTAssertEqual(events[0].payload.objectFields?["error"]?.objectFields?["code"], .string("cancelled"))
            XCTAssertTrue(session.completePlatformCall(id, .success(.number(99)), durationMs: 0).isEmpty)
            XCTAssertNil(session.data?["result"])
        }
        var session = PrototypeSession()
        try session.show(spec())
        _ = try session.run([action()])
        let events = session.dismiss(reason: .user)
        XCTAssertEqual(events.map(\.name), ["prototype_platform", nil])
        XCTAssertEqual(events[0].payload.objectFields?["error"]?.objectFields?["code"], .string("cancelled"))
    }

    func testSupersessionAndInFlightCap() throws {
        var session = PrototypeSession()
        try session.show(spec())
        _ = try session.run([action()])
        let old = try job(session.takePlatformCommands()).call.callId
        let events = try session.run([action()])
        XCTAssertEqual(events.first?.payload.objectFields?["error"]?.objectFields?["code"], .string("cancelled"))
        XCTAssertTrue(session.completePlatformCall(old, .success(.null), durationMs: 0).isEmpty)
        let noInto = try JSONDecoder().decode(PrototypeAction.self, from: Data("""
        {"type":"platform","call":"test.echo","args":{"message":{"value":1}}}
        """.utf8))
        for _ in 0 ..< 3 {
            _ = session.run([noInto])
        }
        let rejected = session.run([noInto])
        XCTAssertEqual(
            rejected.last?.payload.objectFields?["error"]?.objectFields?["code"],
            .string("too_many_in_flight")
        )
    }

    func testHandlerAtomicityAndEventScopeSurvivesAsyncFollowup() throws {
        var session = PrototypeSession()
        try session.show(spec())
        let events = try session.deliverPlatformEvent("test.tick", data: .object(["message": .string("tick")]))
        XCTAssertEqual(events.first?.name, "prototype_platform_event")
        XCTAssertEqual(session.state["n"], .number(1))
        XCTAssertEqual(session.data?["event"], .string("tick"))
        let call = try job(session.takePlatformCommands()).call
        XCTAssertEqual(call.args["message"], .string("tick"))
        _ = session.completePlatformCall(call.callId, .success(.null), durationMs: 0)
        XCTAssertEqual(session.data?["follow"], .string("tick"))
        let outside = try JSONDecoder().decode(PrototypeAction.self, from: Data("""
        {"type":"setData","path":"/data/leaked","value":{"event":"/message"}}
        """.utf8))
        _ = session.run([outside])
        XCTAssertNotEqual(session.data?["leaked"], .string("tick"))
    }

    func testHandlerRejectedWritesAreAtomic() throws {
        let raw = """
        {"id":"p","window":{"placement":{"type":"fullscreen"}},"requires":{"platform":["test"]},
        "state":{"n":0},"platform":{"on":{"test.tick":[
        {"type":"increment","key":"n"},{"type":"setState","key":"n","value":"wrong"}]}},
        "root":{"type":"slider","stateKey":"n","min":0,"max":10}}
        """
        var session = PrototypeSession()
        try session.show(JSONDecoder().decode(PrototypeSpec.self, from: Data(raw.utf8)))
        _ = try session.deliverPlatformEvent("test.tick", data: .null)
        XCTAssertEqual(session.state["n"], .number(0))
    }

    func testOversizedEventIsTruncatedOnWire() throws {
        var session = PrototypeSession()
        try session.show(spec())
        let events = try session.deliverPlatformEvent("test.tick", data: .string(String(repeating: "a", count: 5000)))
        XCTAssertEqual(events.first?.payload.objectFields?["truncated"], .bool(true))
    }

    func testPlatformStateRefreshesRenderedTextWithoutDataRevision() throws {
        var session = PrototypeSession()
        try session.show(spec())
        let revision = session.dataRevision
        try session.setPlatformState(["test": .object(["lastEcho": .string("hello")])])
        XCTAssertEqual(session.spec?.root.text, "hello")
        XCTAssertEqual(session.dataRevision, revision)
        XCTAssertThrowsError(try session.setPlatformState(["test": .object([
            "lastEcho": .string(String(repeating: "x", count: 65536)),
        ])]))
        XCTAssertEqual(session.spec?.root.text, "hello")
    }

    func testPlatformRepeatArgumentsAndFollowupsBind() throws {
        let raw = """
        {"id":"p","window":{"placement":{"type":"fullscreen"}},"requires":{"platform":["test"]},
        "root":{"type":"column","repeat":{"items":[{"title":"row"}],"as":"item"},
        "children":[{"type":"button","label":"Go","onTap":[{"type":"platform","call":"test.echo",
        "args":{"message":{"item":"title"}},"into":"/data/rows/{index}/result"}]}]}}
        """
        let spec = try JSONDecoder().decode(PrototypeSpec.self, from: Data(raw.utf8))
        let action = try XCTUnwrap(spec.root.children?.first?.onTap?.first)
        XCTAssertEqual(action.args?["message"], .object(["value": .string("row")]))
        XCTAssertEqual(action.into, "/data/rows/0/result")
    }

    func testFailedResultWriteRollsBackBody() throws {
        var session = PrototypeSession()
        try session.show(spec())
        _ = try session.run([action()])
        let id = try job(session.takePlatformCommands()).call.callId
        let events = session.completePlatformCall(
            id,
            .success(.string(String(repeating: "x", count: 900_000))),
            durationMs: 1
        )
        XCTAssertNil(session.data?["result"])
        XCTAssertEqual(session.state["status"], .string("error"))
        XCTAssertEqual(events.last?.payload.objectFields?["error"]?.objectFields?["code"], .string("platform_error"))
    }

    @MainActor
    func testDriverDeliversStreamEventsAndStopsOnDismiss() async {
        let module = TestPlatformModule()
        let driver = PrototypePlatformDriver(
            registry: PrototypePlatformRegistry(modules: [module]),
            clock: PlatformClock()
        )
        let event = await withCheckedContinuation { continuation in
            driver.onEvent = { event in continuation.resume(returning: event) }
            driver.subscribe()
            driver.perform([.start(.init(
                call: .init(callId: "p", call: "test.echo", args: ["message": .string("tick")]),
                timeoutMs: 100
            ))])
        }
        XCTAssertEqual(event.event, "test.tick")
        XCTAssertEqual(event.data, .object(["message": .string("tick")]))
        driver.stopEvents()
        driver.onEvent = { _ in XCTFail("Event delivered after unsubscribe") }
        module.continuation.yield(PlatformEvent(event: "test.tick", data: .null))
        await driver.settled()
    }

    @MainActor
    func testInfoPlistFilteringAndCapabilities() {
        let module = FakePlatformModule()
        module.requiredInfoPlistKeys = ["NSCameraUsageDescription", "NSMicrophoneUsageDescription"]
        let withheld = PrototypePlatformRegistry(
            modules: [module],
            bundle: FakeBundleReader(keys: ["NSCameraUsageDescription"])
        )
        XCTAssertTrue(withheld.capabilities.isEmpty)
        XCTAssertTrue(withheld.snapshot.isEmpty)
        let registry = PrototypePlatformRegistry(
            modules: [module],
            bundle: FakeBundleReader(keys: Set(module.requiredInfoPlistKeys))
        )
        XCTAssertEqual(registry.capabilities, [module.capability])
        XCTAssertEqual(registry.snapshot["test"], .object(module.state))
        XCTAssertTrue(
            PrototypeAgentProtocol.advertisedCapabilities(registryCapabilities: registry.capabilities)
                .contains(module.capability)
        )
        XCTAssertFalse(PrototypeAgentProtocol.advertisedCapabilities().contains(module.capability))
    }

    @MainActor
    func testDriverResolvesEchoAndPublishesSnapshot() async {
        let module = TestPlatformModule()
        let driver = PrototypePlatformDriver(
            registry: PrototypePlatformRegistry(modules: [module]),
            clock: PlatformClock()
        )
        var received: PlatformCallResult?
        var snapshot: [String: JSONValue] = [:]
        driver.onComplete = { _, result, _ in received = result }
        driver.onState = { snapshot = $0 }
        driver.perform([.start(.init(
            call: .init(callId: "p-1", call: "test.echo", args: ["message": .string("hello")]),
            timeoutMs: 10
        ))])
        XCTAssertNil(received)
        await driver.settled()
        XCTAssertEqual(received, .success(.string("hello")))
        XCTAssertEqual(snapshot["test"]?.objectFields?["lastEcho"], .string("hello"))
    }

    @MainActor
    func testDriverTimeoutAndCancellationIgnoreLateAnswer() async {
        let module = FakePlatformModule()
        let clock = PlatformClock()
        let driver = PrototypePlatformDriver(registry: PrototypePlatformRegistry(modules: [module]), clock: clock)
        var results: [PlatformCallResult] = []
        driver.onComplete = { _, result, _ in results.append(result) }
        let job = PrototypePlatformJob(
            call: .init(callId: "p-1", call: "test.echo", args: ["message": .null]),
            timeoutMs: 10
        )
        await withCheckedContinuation { continuation in
            module.onCall = { continuation.resume() }
            driver.perform([.start(job)])
        }
        clock.expire()
        module.answer(.success(.string("late")))
        await driver.settled()
        XCTAssertEqual(results, [.failure(.timeout, "Platform call timed out")])
        let next = PrototypePlatformJob(
            call: .init(callId: "p-2", call: "test.echo", args: ["message": .null]),
            timeoutMs: 10
        )
        await withCheckedContinuation { continuation in
            module.onCall = { continuation.resume() }
            driver.perform([.start(next)])
        }
        driver.perform([.cancel("p-2")])
        module.answer(.success(.string("cancelled late")))
        await driver.settled()
        XCTAssertEqual(results.count, 1)
    }

    @MainActor
    func testDriverUnavailableUnsupportedAndInvalidArgs() async {
        let module = FakePlatformModule()
        let registry = PrototypePlatformRegistry(modules: [module])
        let driver = PrototypePlatformDriver(registry: registry, clock: PlatformClock())
        var result: PlatformCallResult?
        driver.onComplete = { _, value, _ in result = value }
        for (call, args, availability, code) in [
            ("missing.echo", ["message": JSONValue.null], PlatformAvailability.ready, PlatformErrorCode.unsupported),
            ("test.echo", [:], .ready, .invalidArgs),
            ("test.echo", ["message": .null], .unavailable("no"), .unavailable),
            ("test.echo", ["message": .null], .needsPermission(["camera"]), .permissionDenied),
        ] {
            module.available = availability
            driver.perform([.start(.init(call: .init(callId: "p", call: call, args: args), timeoutMs: 10))])
            await driver.settled()
            guard case let .failure(actual, _) = result else { XCTFail("Expected failure"); continue }
            XCTAssertEqual(actual, code)
        }
        XCTAssertTrue(module.received.isEmpty)
    }
}
