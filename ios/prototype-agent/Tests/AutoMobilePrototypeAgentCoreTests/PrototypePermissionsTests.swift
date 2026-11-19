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
    var readings: [PrototypePermissionState] = []
    var continuation: AsyncStream<Void>.Continuation?
    var changes: AsyncStream<Void> {
        let (stream, continuation) = AsyncStream.makeStream(of: Void.self)
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
        return readings.isEmpty ? current : readings.removeFirst()
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

    func foreground(_ state: PrototypePermissionState) {
        readings.append(state)
        continuation?.yield(())
    }

    func stop() {
        stops += 1
        continuation?.finish()
        continuation = nil
        // Deliberately retain the request callback to exercise a late native completion.
    }
}

@MainActor
private final class PermissionTestAuthority: PrototypePermissionAuthority {
    var current: PrototypePermissionState = .notDetermined
    var answer: PrototypePermissionState = .granted
    var reads = 0
    var requests = 0
    var stops = 0

    func status() async -> PrototypePermissionState {
        reads += 1
        return current
    }

    func request() async -> PrototypePermissionOutcome {
        requests += 1
        current = answer
        return .status(current)
    }

    func stop() { stops += 1 }
}

@MainActor
private struct PermissionTestBundle: PrototypeBundleReader {
    var keys: Set<String>

    func containsInfoPlistKey(_ key: String) -> Bool { keys.contains(key) }
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

    func testEveryCaptureAuthorizationMapping() {
        let cases: [(PrototypeCaptureAuthorization, PrototypePermissionState)] = [
            (.notDetermined, .notDetermined), (.restricted, .restricted), (.denied, .denied),
            (.authorized, .granted), (.unknown, .unavailable),
        ]
        for (authorization, expected) in cases {
            XCTAssertEqual(authorization.state, expected)
        }
    }

    func testEveryPhotoAndContactsAuthorizationMapping() {
        let cases: [(PrototypePhotoAuthorization, PrototypeContactsAuthorization, PrototypePermissionState)] = [
            (.notDetermined, .notDetermined, .notDetermined), (.restricted, .restricted, .restricted),
            (.denied, .denied, .denied), (.authorized, .authorized, .granted),
            (.limited, .limited, .limited), (.unknown, .unknown, .unavailable),
        ]
        for (photos, contacts, expected) in cases {
            XCTAssertEqual(photos.state, expected)
            XCTAssertEqual(contacts.state, expected)
        }
    }

    func testEveryCalendarAuthorizationMapping() {
        let cases: [(PrototypeCalendarAuthorization, PrototypePermissionState)] = [
            (.notDetermined, .notDetermined), (.restricted, .restricted), (.denied, .denied),
            (.fullAccess, .granted), (.writeOnly, .limited), (.unknown, .unavailable),
        ]
        for (authorization, expected) in cases {
            XCTAssertEqual(authorization.state, expected)
        }
    }

    func testEveryWhenInUseAuthorizationMapping() {
        let cases: [(PrototypeWhenInUseAuthorization, PrototypePermissionState)] = [
            (.notDetermined, .notDetermined), (.restricted, .restricted), (.denied, .denied),
            (.whenInUse, .granted), (.always, .granted), (.unknown, .unavailable),
        ]
        for (authorization, expected) in cases {
            XCTAssertEqual(authorization.state, expected)
        }
    }

    func testNonNotificationAuthorityRequestUpdatesStateAndEmitsOneChange() async throws {
        let source = PermissionTestSource()
        let photos = PermissionTestAuthority()
        photos.answer = .limited
        let module = PrototypePermissionsModule(
            source: source, authorities: ["photos": photos],
            bundle: PermissionTestBundle(keys: ["NSPhotoLibraryUsageDescription"])
        )
        let registry = PrototypePlatformRegistry(modules: [module])
        let stream = module.events
        let actual = await module.call(call(["photos"]))
        XCTAssertEqual(actual, result(["photos": .limited]))
        let spec = try JSONDecoder().decode(PrototypeSpec.self, from: Data("""
        {"id":"permission-state","window":{"placement":{"type":"fullscreen"}},
         "requires":{"platform":["permissions"],"permissions":[{"name":"photos","purpose":"Choose photos"}]},
         "root":{"type":"text","text":"{platform:/permissions/photos}"}}
        """.utf8))
        var session = PrototypeSession()
        session.show(spec)
        try session.setPlatformState(registry.snapshot)
        XCTAssertEqual(session.spec?.root.text, "limited")
        XCTAssertEqual(photos.requests, 1)
        XCTAssertEqual(source.requests, 0)
        module.stop()
        var changes: [PlatformEvent] = []
        for await event in stream where event.event == "permissions.changed" { changes.append(event) }
        XCTAssertEqual(changes.map(\.data), [.object(["name": .string("photos"), "state": .string("limited")])])
        XCTAssertEqual(photos.stops, 1)
    }

    func testForegroundRefreshReadsEveryAuthorityAndEmitsOnlyChanges() async throws {
        let source = PermissionTestSource()
        let camera = PermissionTestAuthority()
        let photos = PermissionTestAuthority()
        let module = PrototypePermissionsModule(
            source: source, authorities: ["camera": camera, "photos": photos],
            bundle: PermissionTestBundle(keys: ["NSCameraUsageDescription", "NSPhotoLibraryUsageDescription"])
        )
        let stream = module.events
        var events = stream.makeAsyncIterator()
        for _ in 0 ..< 3 {
            let baseline = await events.next()
            XCTAssertEqual(baseline, .stateRefresh("permissions"))
        }
        XCTAssertEqual(camera.reads, 1)
        XCTAssertEqual(photos.reads, 1)
        XCTAssertEqual(source.reads, 1)
        camera.current = .denied
        source.foreground(.limited)
        source.foreground(.limited)
        source.continuation?.finish()
        let observation = try XCTUnwrap(module.observation)
        await observation.value
        XCTAssertEqual(camera.reads, 3)
        XCTAssertEqual(photos.reads, 3)
        XCTAssertEqual(source.reads, 3)
        XCTAssertEqual(module.state, [
            "camera": .string("denied"), "notifications": .string("limited"), "photos": .string("notDetermined"),
        ])
        module.stop()
        var changes: [PlatformEvent] = []
        while let event = await events.next() {
            changes.append(event)
        }
        XCTAssertEqual(changes.map(\.data), [
            .object(["name": .string("camera"), "state": .string("denied")]),
            .object(["name": .string("notifications"), "state": .string("limited")]),
        ])
    }

    func testMissingUsageKeySkipsAuthorityAndUnimplementedNameIsUnavailable() async {
        XCTAssertTrue(PrototypePlatformPermissions.hasRequiredUsageKey(for: "notifications", contains: { _ in false }))
        XCTAssertFalse(PrototypePlatformPermissions.hasRequiredUsageKey(for: "unknown", contains: { _ in true }))
        let photosAdd = PermissionTestAuthority()
        let module = PrototypePermissionsModule(
            source: PermissionTestSource(), authorities: ["photosAdd": photosAdd],
            bundle: PermissionTestBundle(keys: ["NSPhotoLibraryUsageDescription"])
        )
        let actual = await module.call(call(["photosAdd", "motion"]))
        XCTAssertEqual(actual, result(["photosAdd": .unavailable, "motion": .unavailable]))
        XCTAssertEqual(module.state["photosAdd"], .string("unavailable"))
        XCTAssertEqual(module.state["motion"], .string("unavailable"))
        module.stop()
        XCTAssertEqual(photosAdd.reads, 0)
        XCTAssertEqual(photosAdd.requests, 0)
        XCTAssertEqual(photosAdd.stops, 0)
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

    func testBoundRequestRejectsWholeUndeclaredListBeforeDispatch() async throws {
        for names in [["notifications", "camera"], ["notifications"]] {
            let source = PermissionTestSource()
            let module = PrototypePermissionsModule(source: source)
            let driver = PrototypePlatformDriver(
                registry: PrototypePlatformRegistry(modules: [module]), clock: LocationClock()
            )
            let encodedNames = try String(decoding: JSONEncoder().encode(names), as: UTF8.self)
            let spec = try JSONDecoder().decode(PrototypeSpec.self, from: Data("""
            {"id":"permission-bound","window":{"placement":{"type":"fullscreen"}},
             "requires":{"platform":["permissions"],
               "permissions":[{"name":"notifications","purpose":"Send updates"}]},
             "state":{"status":"idle"},"data":{"names":\(encodedNames)},
             "root":{"type":"button","label":"Request","onTap":[
               {"type":"platform","call":"permissions.request","args":{"names":{"data":"/names"}},
                "into":"/data/result","statusKey":"status"}
             ]}}
            """.utf8))
            var session = PrototypeSession()
            session.show(spec)
            let action = try XCTUnwrap(spec.root.onTap?.first)
            let events = session.run([action])
            let commands = session.takePlatformCommands()
            driver.onComplete = { id, result, duration in
                _ = session.completePlatformCall(id, result, durationMs: duration)
            }
            driver.perform(commands)
            await driver.settled()
            if names.contains("camera") {
                XCTAssertTrue(commands.isEmpty)
                XCTAssertEqual(session.state["status"], .string("error"))
                let error = try XCTUnwrap(session.data?["result__meta"]?.objectFields?["error"]?.objectFields)
                XCTAssertEqual(error["code"], .string("invalid_args"))
                XCTAssertEqual(error["message"], .string("Permission is not declared in requires.permissions"))
                XCTAssertEqual(events.last?.payload.objectFields?["error"], .object(error))
                XCTAssertEqual(source.reads, 0)
                XCTAssertEqual(source.requests, 0)
            } else {
                XCTAssertEqual(commands.count, 1)
                XCTAssertEqual(session.state["status"], .string("success"))
                XCTAssertEqual(session.data?["result"], .object([
                    "results": .object(["notifications": .string("granted")]),
                ]))
                XCTAssertGreaterThan(source.reads, 0)
                XCTAssertEqual(source.requests, 1)
            }
            module.stop()
        }
    }

    func testStopDropsLateInitialStatus() async throws {
        let source = PermissionTestSource()
        source.holdStatus = true
        let module = PrototypePermissionsModule(source: source)
        let stream: AsyncStream<PlatformEvent> = await withCheckedContinuation { ready in
            let stream = module.events
            source.read = { ready.resume(returning: stream) }
        }
        source.read = nil
        let oldObservation = try XCTUnwrap(module.observation)
        let oldRead = try XCTUnwrap(source.statusWaiter)
        source.statusWaiter = nil
        module.stop()
        // Keep the new baseline pending so it cannot mask a stale write from the stopped task.
        let restarted: AsyncStream<PlatformEvent> = await withCheckedContinuation { ready in
            let stream = module.events
            source.read = { ready.resume(returning: stream) }
        }
        source.read = nil
        let newRead = try XCTUnwrap(source.statusWaiter)
        source.statusWaiter = nil
        var next = restarted.makeAsyncIterator()
        oldRead.resume(returning: .granted)
        await oldObservation.value
        XCTAssertNil(module.state["notifications"])
        newRead.resume(returning: .denied)
        let baseline = await next.next()
        XCTAssertEqual(baseline, .stateRefresh("permissions"))
        XCTAssertEqual(module.state["notifications"], .string("denied"))
        module.stop()
        var restartedEvents: [PlatformEvent] = []
        while let event = await next.next() {
            restartedEvents.append(event)
        }
        XCTAssertEqual(restartedEvents, [])
        var events: [PlatformEvent] = []
        for await event in stream {
            events.append(event)
        }
        XCTAssertEqual(events, [])
        XCTAssertEqual(source.stops, 2)
    }

    func testStopDropsLateForegroundStatus() async throws {
        let source = PermissionTestSource()
        let module = PrototypePermissionsModule(source: source)
        let stream = module.events
        var events = stream.makeAsyncIterator()
        let baseline = await events.next()
        XCTAssertEqual(baseline, .stateRefresh("permissions"))
        XCTAssertEqual(module.state["notifications"], .string("notDetermined"))
        source.holdStatus = true
        await withCheckedContinuation { (ready: CheckedContinuation<Void, Never>) in
            source.read = { ready.resume() }
            source.continuation?.yield(())
        }
        source.read = nil
        let oldObservation = try XCTUnwrap(module.observation)
        let oldRead = try XCTUnwrap(source.statusWaiter)
        source.statusWaiter = nil
        module.stop()
        // Keep the new baseline pending so it cannot mask a stale foreground result.
        let restarted: AsyncStream<PlatformEvent> = await withCheckedContinuation { ready in
            let stream = module.events
            source.read = { ready.resume(returning: stream) }
        }
        source.read = nil
        let newObservation = try XCTUnwrap(module.observation)
        let newRead = try XCTUnwrap(source.statusWaiter)
        source.statusWaiter = nil
        oldRead.resume(returning: .granted)
        await oldObservation.value
        XCTAssertNil(module.state["notifications"])
        module.stop()
        newRead.resume(returning: .denied)
        await newObservation.value
        var changes: [PlatformEvent] = []
        while let event = await events.next() {
            if event.event == "permissions.changed" { changes.append(event) }
        }
        for await event in restarted where event.event == "permissions.changed" {
            changes.append(event)
        }
        XCTAssertEqual(changes, [])
    }

    func testRequestResultSupersedesEarlierReadsButKeepsLaterSettingsChanges() async throws {
        let scenarios: [(initial: Bool, granted: Bool)] = [(true, true), (false, true), (true, false)]
        for (initial, granted) in scenarios {
            let source = PermissionTestSource()
            source.holdStatus = initial
            if !granted { source.outcome = .platformError }
            let module = PrototypePermissionsModule(source: source)
            let stream: AsyncStream<PlatformEvent> = await withCheckedContinuation { ready in
                let stream = module.events
                source.read = { ready.resume(returning: stream) }
            }
            source.read = nil
            var events = stream.makeAsyncIterator()
            if !initial {
                let baseline = await events.next()
                XCTAssertEqual(baseline, .stateRefresh("permissions"))
                source.holdStatus = true
                await withCheckedContinuation { (ready: CheckedContinuation<Void, Never>) in
                    source.read = { ready.resume() }
                    source.continuation?.yield(())
                }
                source.read = nil
            }
            let staleRead = try XCTUnwrap(source.statusWaiter)
            source.statusWaiter = nil
            source.holdStatus = false
            let actual = await module.call(call())
            let expectedState = JSONValue.string(granted ? "granted" : "notDetermined")
            if granted {
                XCTAssertEqual(actual, result(["notifications": .granted]))
            } else {
                XCTAssertEqual(actual, .failure(.platformError, "Permission request failed"))
            }
            XCTAssertEqual(module.state["notifications"], expectedState)
            // Starting the next read proves the observation has processed the stale result.
            source.holdStatus = true
            await withCheckedContinuation { (ready: CheckedContinuation<Void, Never>) in
                source.read = { ready.resume() }
                // For the initial read, the sequence guard must prevent reinitializing the baseline.
                staleRead.resume(returning: .limited)
                source.continuation?.yield(())
            }
            source.read = nil
            XCTAssertEqual(module.state["notifications"], expectedState)
            let settingsRead = try XCTUnwrap(source.statusWaiter)
            source.statusWaiter = nil
            settingsRead.resume(returning: .denied)
            var changes: [JSONValue] = []
            while let event = await events.next() {
                if event.event == "permissions.changed", let state = event.data.objectFields?["state"] {
                    changes.append(state)
                    if state == .string("denied") { break }
                }
            }
            XCTAssertEqual(changes, granted ? [.string("granted"), .string("denied")] : [.string("denied")])
            XCTAssertEqual(module.state["notifications"], .string("denied"))
            module.stop()
        }
    }

    func testCameraRequestPreservesPendingNotificationReads() async throws {
        for initial in [true, false] {
            let source = PermissionTestSource()
            source.current = .limited
            source.holdStatus = initial
            let module = PrototypePermissionsModule(source: source)
            let registry = PrototypePlatformRegistry(modules: [module])
            let stream: AsyncStream<PlatformEvent> = await withCheckedContinuation { ready in
                let stream = module.events
                source.read = { ready.resume(returning: stream) }
            }
            source.read = nil
            var events = stream.makeAsyncIterator()
            if !initial {
                let baseline = await events.next()
                XCTAssertEqual(baseline, .stateRefresh("permissions"))
                source.holdStatus = true
                await withCheckedContinuation { (ready: CheckedContinuation<Void, Never>) in
                    source.read = { ready.resume() }
                    source.continuation?.yield(())
                }
                source.read = nil
            }
            let heldRead = try XCTUnwrap(source.statusWaiter)
            source.statusWaiter = nil
            let actual = await module.call(call(["camera"]))
            XCTAssertEqual(actual, result(["camera": .unavailable]))
            // The next status read is a barrier: the held result has been processed before asserting.
            await withCheckedContinuation { (ready: CheckedContinuation<Void, Never>) in
                source.read = { ready.resume() }
                heldRead.resume(returning: .denied)
                source.continuation?.yield(())
            }
            source.read = nil
            XCTAssertEqual(registry.snapshot["permissions"]?.objectFields, [
                "notifications": .string("denied"), "camera": .string("unavailable"),
            ])
            XCTAssertEqual(source.requests, 0)
            let barrierRead = try XCTUnwrap(source.statusWaiter)
            source.statusWaiter = nil
            let observation = try XCTUnwrap(module.observation)
            module.stop()
            barrierRead.resume(returning: .denied)
            await observation.value
            var remaining: [PlatformEvent] = []
            while let event = await events.next() {
                remaining.append(event)
            }
            let camera = PlatformEvent(event: "permissions.changed", data: .object([
                "name": .string("camera"), "state": .string("unavailable"),
            ]))
            let notification = initial ? PlatformEvent.stateRefresh("permissions") : PlatformEvent(
                event: "permissions.changed", data: .object([
                    "name": .string("notifications"), "state": .string("denied"),
                ])
            )
            XCTAssertEqual(remaining, [camera, notification])
        }
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

    func testDriverKeepsItsExistingDeadlineAndDropsLateGrant() async throws {
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
        let request = try XCTUnwrap(module.requestTask)
        let beforeTimeout = module.state
        clock.advance(1)
        XCTAssertEqual(results.count, 1)
        guard let first = results.first, case .failure(.timeout, _) = first else { return XCTFail("\(results)") }
        source.complete(.granted)
        await request.value
        XCTAssertEqual(module.state, beforeTimeout)
        XCTAssertEqual(results.count, 1)
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
        source.foreground(.granted)
        source.foreground(.granted)
        source.foreground(.denied)
        let events = await changes.value
        XCTAssertEqual(events.map(\.data), ["granted", "denied"].map {
            .object(["name": .string("notifications"), "state": .string($0)])
        })
        registry.releaseSources()
        XCTAssertEqual(source.stops, 0)
        let late = source.continuation
        registry.releaseSources()
        XCTAssertEqual(source.stops, 1)
        late?.yield(())
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
