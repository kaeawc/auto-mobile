@testable import AutoMobilePrototypeAgentCore
import Foundation
import XCTest

@MainActor
private final class PermissionTestSource: PrototypeNotificationAuthorizationSource {
    var current: PrototypePermissionState = .notDetermined
    var answer: PrototypePermissionState = .granted
    var reads = 0
    var requests = 0
    var stops = 0
    var hold = false
    var holdStatus = false
    var outcome: PrototypePermissionOutcome?
    var requested: (() -> Void)?
    var read: (() -> Void)?
    var waiter: CheckedContinuation<PrototypePermissionOutcome, Never>?
    var statusWaiter: CheckedContinuation<PrototypePermissionState, Never>?
    var continuation: AsyncStream<PrototypePermissionState>.Continuation?
    var changes: AsyncStream<PrototypePermissionState> {
        let (stream, continuation) = AsyncStream.makeStream(of: PrototypePermissionState.self)
        self.continuation = continuation
        return stream
    }

    func status() async -> PrototypePermissionState {
        reads += 1
        if holdStatus {
            return await withCheckedContinuation {
                statusWaiter = $0
                read?()
            }
        }
        read?()
        return current
    }

    func request() async -> PrototypePermissionOutcome {
        requests += 1
        if let outcome { return outcome }
        if hold {
            return await withCheckedContinuation {
                waiter = $0
                requested?()
            }
        }
        current = answer
        return .status(current)
    }

    func complete(_ state: PrototypePermissionState) {
        let waiter = waiter
        self.waiter = nil
        waiter?.resume(returning: .status(state))
    }

    func stop() {
        stops += 1
        continuation?.finish()
        continuation = nil
        // Deliberately retain the request callback to exercise a late native completion.
    }
}

@MainActor
private final class PermissionRegistryServices: PrototypeHapticsPlayer, PrototypeSoundPlayer,
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

@MainActor
final class PrototypePermissionsTests: XCTestCase {
    private func call(_ names: [String] = ["notifications"]) -> PlatformCall {
        PlatformCall(
            callId: "permission",
            call: "permissions.request",
            args: ["names": .array(names.map(JSONValue.string))]
        )
    }

    private func result(_ values: [String: PrototypePermissionState]) -> PlatformCallResult {
        .success(.object(["results": .object(values.mapValues { .string($0.rawValue) })]))
    }

    private func heldRequest(
        _ module: PrototypePermissionsModule, source: PermissionTestSource
    )
        async -> Task<PlatformCallResult, Never>
    {
        await withCheckedContinuation { ready in
            let task = Task { await module.call(call()) }
            source.requested = { ready.resume(returning: task) }
        }
    }

    func testEveryNotificationAuthorizationMappingAndAppBundleGate() {
        let cases: [(PrototypeNotificationAuthorization, PrototypePermissionState)] = [
            (.notDetermined, .notDetermined), (.denied, .denied), (.authorized, .granted),
            (.provisional, .limited), (.ephemeral, .granted), (.unknown, .unavailable),
        ]
        for (authorization, expected) in cases {
            XCTAssertEqual(authorization.state, expected)
        }
        XCTAssertTrue(PrototypeNotificationAuthorization.canAccessCenter(
            bundlePath: "/Host.app",
            bundleIdentifier: "host"
        ))
        let unavailableHosts: [(String, String?)] = [
            ("/Host.xctest", "host"), ("/usr/bin/swift", nil), ("/Host.app", nil),
        ]
        for (path, identifier) in unavailableHosts {
            XCTAssertFalse(PrototypeNotificationAuthorization.canAccessCenter(
                bundlePath: path,
                bundleIdentifier: identifier
            ))
        }
    }

    func testExplicitRequestGrantsOrDeniesAndPublishesResults() async {
        for answer in [PrototypePermissionState.granted, .denied] {
            let source = PermissionTestSource()
            source.answer = answer
            let module = PrototypePermissionsModule(source: source)
            let stream = module.events
            let actual = await module.call(call(["notifications", "camera"]))
            XCTAssertEqual(actual, result(["notifications": answer, "camera": .unavailable]))
            XCTAssertEqual(module.state["notifications"], .string(answer.rawValue))
            XCTAssertEqual(module.state["camera"], .string("unavailable"))
            XCTAssertEqual(source.requests, 1)
            module.stop()
            var events: [PlatformEvent] = []
            for await event in stream where event.event == "permissions.changed" { events.append(event) }
            XCTAssertEqual(events, [
                PlatformEvent(event: "permissions.changed", data: .object([
                    "name": .string("notifications"), "state": .string(answer.rawValue),
                ])),
                PlatformEvent(event: "permissions.changed", data: .object([
                    "name": .string("camera"), "state": .string("unavailable"),
                ])),
            ])
        }
    }

    func testDeterminedOrUnavailableStatusNeverPrompts() async {
        for state in PrototypePermissionState.allCases where state != .notDetermined {
            let source = PermissionTestSource()
            source.current = state
            let module = PrototypePermissionsModule(source: source)
            let actual = await module.call(call())
            XCTAssertEqual(actual, result(["notifications": state]))
            XCTAssertEqual(source.requests, 0)
            module.stop()
        }
    }

    func testSourceOutcomesReturnTypedErrorsAndReleaseSlot() async {
        let cases: [(PrototypePermissionOutcome, PlatformErrorCode)] = [
            (.busy, .tooManyInFlight), (.cancelled, .cancelled), (.platformError, .platformError),
        ]
        for (outcome, code) in cases {
            let source = PermissionTestSource()
            source.outcome = outcome
            let module = PrototypePermissionsModule(source: source)
            let actual = await module.call(call())
            guard case let .failure(actualCode, _) = actual else { XCTFail("\(actual)"); continue }
            XCTAssertEqual(actualCode, code)
            source.current = .denied
            let next = await module.call(call())
            XCTAssertEqual(next, result(["notifications": .denied]))
            module.stop()
        }
    }

    func testStopDropsLateInitialStatus() async {
        let source = PermissionTestSource()
        source.holdStatus = true
        let module = PrototypePermissionsModule(source: source)
        let stream: AsyncStream<PlatformEvent> = await withCheckedContinuation { ready in
            let stream = module.events
            source.read = { ready.resume(returning: stream) }
        }
        module.stop()
        source.statusWaiter?.resume(returning: .granted)
        source.statusWaiter = nil
        var events: [PlatformEvent] = []
        for await event in stream {
            events.append(event)
        }
        XCTAssertEqual(events, [])
        XCTAssertEqual(source.stops, 1)
    }

    func testEveryOtherCanonicalNameIsUnavailable() async {
        let source = PermissionTestSource()
        let module = PrototypePermissionsModule(source: source)
        let names = PrototypePlatformPermissions.names.sorted().filter { $0 != "notifications" }
        let actual = await module.call(call(names))
        XCTAssertEqual(actual, result(Dictionary(uniqueKeysWithValues: names.map { ($0, .unavailable) })))
        for name in names {
            XCTAssertEqual(module.state[name], .string("unavailable"))
        }
        XCTAssertEqual(source.requests, 0)
        module.stop()
    }

    func testInvalidArgumentsAndUnknownCallDoNotReadSource() async throws {
        let source = PermissionTestSource()
        let module = PrototypePermissionsModule(source: source)
        for raw in [
            "{}",
            #"{"names":[]}"#,
            #"{"names":["unknown"]}"#,
            #"{"names":["notifications","notifications"]}"#,
            #"{"names":"notifications"}"#,
            #"{"names":[1]}"#,
            #"{"names":["notifications"],"extra":true}"#,
        ] {
            let args = try XCTUnwrap(JSONDecoder().decode(JSONValue.self, from: Data(raw.utf8)).objectFields)
            let actual = await module.call(PlatformCall(callId: "bad", call: "permissions.request", args: args))
            guard case .failure(.invalidArgs, _) = actual else { XCTFail("\(raw): \(actual)"); continue }
        }
        let unknown = await module.call(PlatformCall(callId: "bad", call: "permissions.other", args: [:]))
        guard case .failure(.unsupported, _) = unknown else { return XCTFail("\(unknown)") }
        XCTAssertEqual(source.reads, 0)
        XCTAssertEqual(source.requests, 0)
    }

    func testConcurrentRequestIsRejectedAndStopDropsLateResult() async {
        let source = PermissionTestSource()
        source.hold = true
        let module = PrototypePermissionsModule(source: source)
        let stream = module.events
        let pending = await heldRequest(module, source: source)
        let second = await module.call(call())
        guard case .failure(.tooManyInFlight, _) = second else { return XCTFail("\(second)") }
        module.stop()
        let cancelled = await pending.value
        guard case .failure(.cancelled, _) = cancelled else { return XCTFail("\(cancelled)") }
        source.complete(.granted)
        var events: [PlatformEvent] = []
        for await event in stream where event.event == "permissions.changed" { events.append(event) }
        XCTAssertEqual(events, [])
        XCTAssertEqual(source.stops, 1)
    }

    func testCallerCancellationDropsLateResultAndReleasesRequestSlot() async {
        let source = PermissionTestSource()
        source.hold = true
        let module = PrototypePermissionsModule(source: source)
        let pending = await heldRequest(module, source: source)
        pending.cancel()
        let actual = await pending.value
        guard case .failure(.cancelled, _) = actual else { return XCTFail("\(actual)") }
        source.complete(.granted)
        source.current = .denied
        let next = await module.call(call())
        XCTAssertEqual(next, result(["notifications": .denied]))
        module.stop()
    }

    func testDriverKeepsItsExistingDeadlineAndDropsLateGrant() async {
        let source = PermissionTestSource()
        source.hold = true
        let module = PrototypePermissionsModule(source: source)
        let clock = LocationClock()
        let stream = module.events
        let driver = PrototypePlatformDriver(registry: PrototypePlatformRegistry(modules: [module]), clock: clock)
        var results: [PlatformCallResult] = []
        driver.onComplete = { _, result, _ in results.append(result) }
        await withCheckedContinuation { (ready: CheckedContinuation<Void, Never>) in
            source.requested = { ready.resume() }
            driver.perform([.start(PrototypePlatformJob(call: call(), timeoutMs: 1))])
        }
        clock.advance(1)
        XCTAssertEqual(results.count, 1)
        guard let first = results.first, case .failure(.timeout, _) = first else { return XCTFail("\(results)") }
        source.complete(.granted)
        module.stop()
        var events: [PlatformEvent] = []
        for await event in stream where event.event == "permissions.changed" { events.append(event) }
        XCTAssertEqual(events, [])
        XCTAssertEqual(results.count, 1)
        XCTAssertEqual(clock.live, 0)
    }

    func testLazyBaselineForegroundChangesAndRefCountedRestart() async {
        let source = PermissionTestSource()
        source.current = .limited
        let module = PrototypePermissionsModule(source: source)
        let registry = PrototypePlatformRegistry(modules: [module])
        XCTAssertEqual(source.reads, 0)
        XCTAssertEqual(module.requiredInfoPlistKeys, [])
        registry.retainSources()
        registry.retainSources()
        let stream: AsyncStream<PlatformEvent> = await withCheckedContinuation { ready in
            let stream = module.events
            source.read = { ready.resume(returning: stream) }
        }
        source.read = nil
        XCTAssertEqual(module.state["notifications"], .string("limited"))
        let changes = Task { () -> [PlatformEvent] in
            var events: [PlatformEvent] = []
            for await event in stream where event.event == "permissions.changed" {
                events.append(event)
                if events.count == 2 { break }
            }
            return events
        }
        source.continuation?.yield(.granted)
        source.continuation?.yield(.granted)
        source.continuation?.yield(.denied)
        let events = await changes.value
        XCTAssertEqual(events.map(\.data), ["granted", "denied"].map {
            .object(["name": .string("notifications"), "state": .string($0)])
        })
        registry.releaseSources()
        XCTAssertEqual(source.stops, 0)
        let late = source.continuation
        registry.releaseSources()
        XCTAssertEqual(source.stops, 1)
        late?.yield(.granted)
        registry.retainSources()
        source.current = .denied
        await withCheckedContinuation { (ready: CheckedContinuation<Void, Never>) in
            source.read = { ready.resume() }
            _ = module.state
        }
        source.read = nil
        XCTAssertEqual(module.state["notifications"], .string("denied"))
        registry.releaseSources()
        XCTAssertEqual(source.stops, 2)
        XCTAssertEqual(source.requests, 0)
    }

    func testBothProductionFactoriesAdvertiseOnlyWithSource() {
        let services = PermissionRegistryServices()
        for supplied in [false, true] {
            let source: (any PrototypeNotificationAuthorizationSource)? = supplied ? PermissionTestSource() : nil
            let registries = [
                PrototypePlatformRegistry.feedbackModules(
                    haptics: services, sound: services, connectivity: services, links: services, settings: services,
                    permissions: source
                ),
                PrototypePlatformRegistry.systemModules(
                    clipboard: FakePrototypeClipboard(), connectivity: services, links: services, settings: services,
                    permissions: source
                ),
            ]
            for registry in registries {
                XCTAssertEqual(registry.capabilities.contains("prototype_platform_permissions_v1"), supplied)
                XCTAssertEqual(registry.modules["permissions"] != nil, supplied)
            }
        }
    }
}
