@testable import AutoMobilePrototypeAgentCore
import Foundation
import XCTest

private final class LocationTimer: PrototypeTimerHandle {
    let deadline: Int
    let fire: () -> Void
    var cancelled = false
    init(deadline: Int, fire: @escaping () -> Void) { self.deadline = deadline; self.fire = fire }
    func cancel() { cancelled = true }
}

final class LocationClock: PrototypeClock {
    var nowMilliseconds = 0
    private var timers: [LocationTimer] = []
    var live: Int { timers.filter { !$0.cancelled }.count }
    func schedule(afterMilliseconds delay: Int, _ fire: @escaping () -> Void) -> any PrototypeTimerHandle {
        let timer = LocationTimer(deadline: nowMilliseconds + delay, fire: fire)
        timers.append(timer)
        return timer
    }

    func advance(_ milliseconds: Int) {
        nowMilliseconds += milliseconds
        let due = timers.filter { !$0.cancelled && $0.deadline <= nowMilliseconds }
        for timer in due { timer.cancel(); timer.fire() }
    }
}

@MainActor
struct LocationBundle: PrototypeBundleReader {
    var keys: Set<String> = ["NSLocationWhenInUseUsageDescription"]
    func containsInfoPlistKey(_ key: String) -> Bool { keys.contains(key) }
}

@MainActor
final class LocationTestSource: PrototypeLocationSource {
    var touches = 0
    var enabled = true
    var grant: PrototypeLocationAuthorization = .authorizedPrecise
    var afterPrompt: PrototypeLocationAuthorization = .authorizedPrecise
    var temporaryGrant = false
    var prompts = 0
    var temporaryPrompts = 0
    var requests: [String] = []
    var distances: [Double] = []
    var updateAccuracies: [String] = []
    var stops = 0
    var failure: PrototypeLocationSourceError?
    var fix = PrototypeLocationFix(latitude: 1, longitude: 2, accuracyM: 3, timestampMs: 0, approximate: false)
    var handler: (@MainActor @Sendable (PrototypeLocationFix) -> Void)?
    var servicesEnabled: Bool { touches += 1; return enabled }
    var authorization: PrototypeLocationAuthorization { touches += 1; return grant }
    func requestAuthorization() async { touches += 1; prompts += 1; grant = afterPrompt }
    func requestFix(accuracy: String) async throws -> PrototypeLocationFix {
        touches += 1
        requests.append(accuracy)
        if let failure { throw failure }
        return fix
    }

    func requestTemporaryFullAccuracy() async -> Bool {
        touches += 1
        temporaryPrompts += 1
        if temporaryGrant { grant = .authorizedPrecise }
        return temporaryGrant
    }

    func setUpdateAccuracy(_ accuracy: String) { touches += 1; updateAccuracies.append(accuracy) }

    func startUpdates(
        minDistanceM: Double,
        _ handler: @escaping @MainActor @Sendable (PrototypeLocationFix) -> Void
    ) {
        touches += 1
        distances.append(minDistanceM)
        self.handler = handler
    }

    func stopUpdates() { touches += 1; stops += 1; handler = nil }
    func report(_ fix: PrototypeLocationFix) { handler?(fix) }
}

@MainActor
private final class LocationRegistryServices: PrototypeHapticsPlayer, PrototypeSoundPlayer,
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
final class PrototypeLocationTests: XCTestCase {
    private func call(_ args: [String: JSONValue] = [:]) -> PlatformCall {
        PlatformCall(callId: "l", call: "location.request", args: args)
    }

    private func module(_ source: LocationTestSource, clock: LocationClock = LocationClock())
        -> PrototypeLocationModule
    {
        PrototypeLocationModule(source: source, bundle: LocationBundle(), clock: clock)
    }

    func testMissingUsageDescriptionNeverTouchesSource() async {
        let source = LocationTestSource()
        let module = PrototypeLocationModule(source: source, bundle: LocationBundle(keys: []), clock: LocationClock())
        XCTAssertTrue(module.requiredInfoPlistKeys.isEmpty)
        XCTAssertEqual(module.availability(), .unavailable("missing_usage_description"))
        let result = await module.call(call())
        XCTAssertEqual(result, .failure(.unavailable, "missing_usage_description"))
        module.configure(root: .object([:]))
        _ = module.events
        XCTAssertEqual(module.state["current"], .object([:]))
        XCTAssertEqual(source.touches, 0)
    }

    func testDisabledServices() async {
        let source = LocationTestSource()
        source.enabled = false
        let module = module(source)
        let result = await module.call(call())
        XCTAssertEqual(result, .failure(.unavailable, "disabled"))
        XCTAssertEqual(module.state["servicesEnabled"], .bool(false))
        XCTAssertTrue(source.requests.isEmpty)
    }

    func testReducedAccuracyIsSuccessfulAndTemporaryAccessRequiresDictionary() async {
        for hasDictionary in [false, true] {
            for granted in [false, true] {
                let source = LocationTestSource()
                source.grant = .authorizedApproximate
                source.temporaryGrant = granted
                var bundle = LocationBundle()
                if hasDictionary { bundle.keys.insert("NSLocationTemporaryUsageDescriptionDictionary") }
                let module = PrototypeLocationModule(source: source, bundle: bundle, clock: LocationClock())
                let result = await module.call(call(["accuracy": .string("precise")]))
                guard case let .success(fix) = result else { XCTFail("Expected fix"); continue }
                XCTAssertEqual(fix.objectFields?["approximate"], .bool(!(hasDictionary && granted)))
                XCTAssertEqual(source.temporaryPrompts, hasDictionary ? 1 : 0)
                XCTAssertNil(fix.objectFields?["altitudeM"])
                XCTAssertEqual(module.state["current"], fix)
            }
        }
        let source = LocationTestSource()
        source.grant = .authorizedApproximate
        let module = PrototypeLocationModule(
            source: source,
            bundle: LocationBundle(keys: [
                "NSLocationWhenInUseUsageDescription", "NSLocationTemporaryUsageDescriptionDictionary",
            ]),
            clock: LocationClock()
        )
        _ = await module.call(call(["accuracy": .string("approximate")]))
        XCTAssertEqual(source.temporaryPrompts, 0)
    }

    func testDeniedRestrictedAndPromptTransitions() async {
        for grant in [PrototypeLocationAuthorization.denied, .restricted] {
            let source = LocationTestSource()
            source.grant = grant
            let result = await module(source).call(call())
            XCTAssertEqual(result, .failure(.permissionDenied, "Location permission denied"))
            XCTAssertTrue(source.requests.isEmpty)
            XCTAssertEqual(source.prompts, 0)
        }
        let source = LocationTestSource()
        source.grant = .notDetermined
        let module = module(source)
        module.configure(root: .object([:]))
        XCTAssertEqual(source.prompts, 0)
        XCTAssertTrue(source.distances.isEmpty)
        let result = await module.call(call())
        XCTAssertEqual(result, .success(source.fix.json))
        XCTAssertEqual(source.prompts, 1)
        XCTAssertEqual(source.distances, [0], "an explicit call can enable an already configured subscription")
        source.grant = .notDetermined
        source.afterPrompt = .denied
        let denied = await module.call(call())
        XCTAssertEqual(denied, .failure(.permissionDenied, "Location permission denied"))
    }

    func testCacheIncludesMaxAgeBoundaryAndExpiresAfterIt() async {
        let source = LocationTestSource()
        let clock = LocationClock()
        let module = module(source, clock: clock)
        _ = await module.call(call())
        clock.advance(1000)
        _ = await module.call(call(["maxAgeMs": .number(1000)]))
        XCTAssertEqual(source.requests.count, 1)
        clock.advance(1)
        _ = await module.call(call(["maxAgeMs": .number(1000)]))
        XCTAssertEqual(source.requests.count, 2)
    }

    func testErrorsAndInvalidFixesAreTypedAndContainNoCoordinates() async {
        for (error, code) in [
            (PrototypeLocationSourceError.timeout, PlatformErrorCode.timeout),
            (.unavailable, .unavailable), (.platformError, .platformError), (.permissionDenied, .permissionDenied),
        ] {
            let source = LocationTestSource()
            source.failure = error
            let result = await module(source).call(call())
            guard case let .failure(actual, _) = result else { XCTFail("Expected error"); continue }
            XCTAssertEqual(actual, code)
        }
        let invalid = [
            PrototypeLocationFix(latitude: 91, longitude: 2, accuracyM: 3, timestampMs: 0, approximate: false),
            PrototypeLocationFix(latitude: 1, longitude: -181, accuracyM: 3, timestampMs: 0, approximate: false),
            PrototypeLocationFix(latitude: 1, longitude: 2, accuracyM: -1, timestampMs: 0, approximate: false),
            PrototypeLocationFix(
                latitude: 1, longitude: 2, accuracyM: 3, altitudeM: 100001, timestampMs: 0, approximate: false
            ),
            PrototypeLocationFix(
                latitude: 1, longitude: 2, accuracyM: 3, speedMps: -1, timestampMs: 0, approximate: false
            ),
            PrototypeLocationFix(
                latitude: 1, longitude: 2, accuracyM: 3, bearingDeg: 361, timestampMs: 0, approximate: false
            ),
            PrototypeLocationFix(latitude: 1, longitude: 2, accuracyM: 3, timestampMs: .infinity, approximate: false),
        ]
        for fix in invalid {
            let source = LocationTestSource()
            source.fix = fix
            let module = module(source)
            let result = await module.call(call())
            XCTAssertEqual(result, .failure(.platformError, "Invalid location fix"))
            XCTAssertEqual(module.state["current"], .object([:]))
        }
    }

    func testTrailingLatestThrottleAndDistanceFilterAndStop() {
        let source = LocationTestSource()
        let clock = LocationClock()
        let module = module(source, clock: clock)
        module.configure(root: .object(["minIntervalMs": .number(1000), "minDistanceM": .number(100)]))
        XCTAssertEqual(source.distances, [100])
        XCTAssertEqual(source.updateAccuracies, ["precise"])
        let first = source.fix
        let second = PrototypeLocationFix(latitude: 2, longitude: 2, accuracyM: 4, timestampMs: 1, approximate: false)
        let third = PrototypeLocationFix(latitude: 3, longitude: 2, accuracyM: 5, timestampMs: 2, approximate: false)
        source.report(first)
        source.report(second)
        clock.advance(400)
        source.report(third)
        XCTAssertEqual(clock.live, 1)
        XCTAssertEqual(module.state["current"], first.json)
        clock.advance(599)
        XCTAssertEqual(module.state["current"], first.json)
        clock.advance(1)
        XCTAssertEqual(module.state["current"], third.json)
        source.report(PrototypeLocationFix(
            latitude: 3.00001, longitude: 2, accuracyM: 5, timestampMs: 3, approximate: false
        ))
        XCTAssertEqual(clock.live, 0, "sub-distance fixes do not schedule a delivery")
        source.report(second)
        XCTAssertEqual(clock.live, 1)
        let lateCallback = source.handler
        module.configure(root: nil)
        XCTAssertEqual(source.stops, 1)
        XCTAssertEqual(clock.live, 0)
        lateCallback?(second)
        clock.advance(1000)
        XCTAssertEqual(module.state["current"], third.json)
    }

    func testSubscriptionsNeverPromptForAnyAuthorization() {
        let grants: [PrototypeLocationAuthorization] = [
            .notDetermined, .denied, .restricted, .authorizedApproximate, .authorizedPrecise,
        ]
        for grant in grants {
            let source = LocationTestSource()
            source.grant = grant
            let module = module(source)
            module.configure(root: .object([:]))
            XCTAssertEqual(source.prompts, 0)
            XCTAssertEqual(source.temporaryPrompts, 0)
            XCTAssertEqual(source.distances.count, grant.authorized ? 1 : 0)
            module.configure(root: nil)
        }
    }

    /// Drain buffered events on this actor, then cancel the suspended iterator. The readiness
    /// continuation lets the caller cancel even when a regression produces no events.
    private func bufferedEvents(_ stream: AsyncStream<PlatformEvent>) async -> [PlatformEvent] {
        var collector: Task<[PlatformEvent], Never>?
        await withCheckedContinuation { ready in
            collector = Task { @MainActor in
                ready.resume()
                var values: [PlatformEvent] = []
                var iterator = stream.makeAsyncIterator()
                while let event = await iterator.next(isolation: MainActor.shared) { values.append(event) }
                return values
            }
        }
        guard let collector else { return [] }
        collector.cancel()
        return await collector.value
    }

    func testSharedEventFixturesReplayThroughModuleWithOnlyAccuracySummary() async throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test/fixtures/prototype-location/event-summary.json")
        let fixture = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url))
        guard case let .array(cases)? = fixture.objectFields?["cases"] else { return XCTFail("Expected cases") }
        for raw in cases {
            let fields = try XCTUnwrap(raw.objectFields)
            let fix = try XCTUnwrap(fields["fix"]?.objectFields)
            let source = LocationTestSource()
            let module = module(source)
            let stream = module.events
            module.configure(root: .object([:]))
            source.report(PrototypeLocationFix(
                latitude: try XCTUnwrap(fix["latitude"]?.numberValue),
                longitude: try XCTUnwrap(fix["longitude"]?.numberValue),
                accuracyM: try XCTUnwrap(fix["accuracyM"]?.numberValue),
                altitudeM: fix["altitudeM"]?.numberValue,
                speedMps: fix["speedMps"]?.numberValue,
                bearingDeg: fix["bearingDeg"]?.numberValue,
                timestampMs: try XCTUnwrap(fix["timestampMs"]?.numberValue),
                approximate: try XCTUnwrap(fix["approximate"]?.boolValue)
            ))
            let events = await bufferedEvents(stream)
            XCTAssertEqual(events, [
                .stateRefresh("location"),
                PlatformEvent(event: "location.updated", data: try XCTUnwrap(fields["expected"])),
            ])
            module.configure(root: nil)
        }
    }

    func testRawSubscriptionBlockSurvivesSpecCopies() throws {
        let url = PrototypeSpecFixtures.directory.appendingPathComponent("valid/platform-location.json")
        let fixture = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url))
        var fields = try XCTUnwrap(fixture.objectFields)
        let block = JSONValue.object([
            "accuracy": .string("approximate"), "minIntervalMs": .number(2000), "minDistanceM": .number(50),
        ])
        fields["location"] = block
        let spec = try JSONDecoder().decode(PrototypeSpec.self, from: JSONEncoder().encode(JSONValue.object(fields)))
        XCTAssertEqual(spec.locationBlock, block)
        XCTAssertEqual(try spec.replacingPlatform([:]).locationBlock, block)
        let source = LocationTestSource()
        let module = module(source)
        module.configure(root: spec.locationBlock)
        XCTAssertEqual(source.updateAccuracies, ["approximate"])
        XCTAssertEqual(source.distances, [50])
        XCTAssertEqual(source.temporaryPrompts, 0)
        module.configure(root: nil)
    }

    func testProductionRegistryMembershipIsOptInForBothFactories() {
        let services = LocationRegistryServices()
        let source = LocationTestSource()
        for supplied in [false, true] {
            let location: (any PrototypeLocationSource)? = supplied ? source : nil
            let registries = [
                PrototypePlatformRegistry.feedbackModules(
                    haptics: services, sound: services, connectivity: services, links: services, settings: services,
                    bundle: LocationBundle(), location: location
                ),
                PrototypePlatformRegistry.systemModules(
                    clipboard: FakePrototypeClipboard(), connectivity: services, links: services, settings: services,
                    bundle: LocationBundle(), location: location
                ),
            ]
            for registry in registries {
                XCTAssertEqual(registry.capabilities.contains("prototype_platform_location_v1"), supplied)
                registry.configure(locationBlock: .object([:]))
                registry.configure(locationBlock: nil)
            }
        }
    }
}
