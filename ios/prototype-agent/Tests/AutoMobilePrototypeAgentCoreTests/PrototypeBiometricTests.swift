@testable import AutoMobilePrototypeAgentCore
import Foundation
import XCTest
#if canImport(LocalAuthentication)
    import LocalAuthentication
#endif

@MainActor
private final class BiometricBundle: PrototypeBundleReader {
    var keys: Set<String> = []
    var reads: [String] = []
    func containsInfoPlistKey(_ key: String) -> Bool { reads.append(key); return keys.contains(key) }
}

@MainActor
private final class BiometricSource: PrototypeBiometricSource {
    var available: PrototypeBiometricAvailability = .ready(usesFaceID: false)
    var credentialAvailability: PrototypeBiometricAvailability?
    var availabilityPolicies: [Bool] = []
    var evaluations: [Bool] = []
    var titles: [String] = []
    var subtitles: [String?] = []
    var invalidations = 0
    var outcomes: [PrototypeBiometricOutcome] = [.success]
    var hold = false
    var onEvaluate: (() -> Void)?
    private var waiter: CheckedContinuation<PrototypeBiometricOutcome, Never>?

    func availability(allowDeviceCredential: Bool) -> PrototypeBiometricAvailability {
        availabilityPolicies.append(allowDeviceCredential)
        return allowDeviceCredential ? credentialAvailability ?? available : available
    }

    func evaluate(title: String, subtitle: String?, allowDeviceCredential: Bool) async -> PrototypeBiometricOutcome {
        evaluations.append(allowDeviceCredential)
        titles.append(title)
        subtitles.append(subtitle)
        if hold {
            return await withCheckedContinuation { continuation in
                waiter = continuation
                onEvaluate?()
            }
        }
        return outcomes.removeFirst()
    }

    func cancel() {
        guard let waiter else { return }
        self.waiter = nil
        invalidations += 1
        waiter.resume(returning: .cancelled)
    }
}

@MainActor
private final class BiometricRegistryServices: PrototypeHapticsPlayer, PrototypeSoundPlayer,
    PrototypeConnectivitySource, PrototypeLinkOpener, PrototypeSettingsURLOpener, PrototypeClipboard
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
    var hasText: Bool { false }
    func copy(text _: String, sensitive _: Bool, label _: String?) {}
    func paste() async throws -> String { "" }
}

@MainActor
final class PrototypeBiometricTests: XCTestCase {
    private func call(_ extra: [String: JSONValue] = [:]) -> PlatformCall {
        PlatformCall(
            callId: "b",
            call: "biometric.authenticate",
            args: ["title": .string("Unlock")].merging(extra) { _, value in value }
        )
    }

    func testSuccessAndPolicySelection() async {
        for credential in [false, true] {
            let source = BiometricSource()
            let module = PrototypeBiometricModule(source: source, bundle: BiometricBundle())
            let result = await module.call(call([
                "allowDeviceCredential": .bool(credential),
                "subtitle": .string("Confirm"),
            ]))
            XCTAssertEqual(result, .success(.object([:])))
            XCTAssertEqual(source.availabilityPolicies, [credential])
            XCTAssertEqual(source.evaluations, [credential])
            XCTAssertEqual(source.titles, ["Unlock"])
            XCTAssertEqual(source.subtitles, ["Confirm"])
            XCTAssertTrue(module.state.isEmpty)
            XCTAssertTrue(module.requiredInfoPlistKeys.isEmpty)
            module.stop()
            XCTAssertEqual(source.invalidations, 0)
        }
    }

    func testCredentialPolicyAllowsPasscodeWithoutEnrollmentOrDuringLockout() async {
        for reason in [PrototypeBiometricUnavailableReason.notEnrolled, .lockout] {
            let source = BiometricSource()
            source.available = .unavailable(reason)
            source.credentialAvailability = .ready(usesFaceID: false)
            let module = PrototypeBiometricModule(source: source, bundle: BiometricBundle())
            XCTAssertEqual(module.availability(), .ready, "Driver preflight must not assume biometrics-only policy")
            let result = await module.call(call(["allowDeviceCredential": .bool(true)]))
            XCTAssertEqual(result, .success(.object([:])))
            XCTAssertEqual(source.evaluations, [true])
        }
    }

    func testFailedAttemptsEmitEmptyEventsAndRetryThenSuccess() async {
        let source = BiometricSource()
        source.outcomes = [.attemptFailed, .attemptFailed, .success]
        let module = PrototypeBiometricModule(source: source, bundle: BiometricBundle())
        let stream = module.events
        let result = await module.call(call())
        XCTAssertEqual(result, .success(.object([:])))
        XCTAssertEqual(source.evaluations, [false, false, false])
        module.stop()
        var events: [PlatformEvent] = []
        for await event in stream {
            events.append(event)
        }
        XCTAssertEqual(
            events,
            Array(repeating: PlatformEvent(event: "biometric.attemptFailed", data: .object([:])), count: 2)
        )
    }

    func testAvailabilityAndMidflightReasons() async {
        for reason in PrototypeBiometricUnavailableReason.allCases where reason != .missingUsageDescription {
            for preflight in [false, true] {
                let source = BiometricSource()
                if preflight { source.available = .unavailable(reason) }
                else { source.outcomes = [.unavailable(reason)] }
                let module = PrototypeBiometricModule(source: source, bundle: BiometricBundle())
                let result = await module.call(call())
                XCTAssertEqual(result, .failure(.unavailable, reason.rawValue))
                XCTAssertEqual(source.evaluations.count, preflight ? 0 : 1)
            }
        }
    }

    func testFaceIDRequiresUsageDescriptionButTouchIDDoesNot() async {
        for faceID in [false, true] {
            for hasUsage in [false, true] {
                let source = BiometricSource()
                source.available = .ready(usesFaceID: faceID)
                let bundle = BiometricBundle()
                if hasUsage { bundle.keys.insert("NSFaceIDUsageDescription") }
                let module = PrototypeBiometricModule(source: source, bundle: bundle)
                let result = await module.call(call())
                let missing = faceID && !hasUsage
                XCTAssertEqual(
                    result,
                    missing ? .failure(.unavailable, "missing_usage_description") : .success(.object([:]))
                )
                XCTAssertEqual(source.evaluations.count, missing ? 0 : 1)
                XCTAssertEqual(bundle.reads, faceID ? ["NSFaceIDUsageDescription"] : [])
            }
        }
    }

    func testFaceIDUsageDescriptionIsCheckedEvenWhenEnrollmentIsMissing() async {
        let source = BiometricSource()
        source.available = .unavailable(.notEnrolled, usesFaceID: true)
        let result = await PrototypeBiometricModule(source: source, bundle: BiometricBundle()).call(call())
        XCTAssertEqual(result, .failure(.unavailable, "missing_usage_description"))
        XCTAssertTrue(source.evaluations.isEmpty)
    }

    func testInvalidArgumentsAndWrongNamePrecedeSourceAccess() async {
        let source = BiometricSource()
        source.available = .unavailable(.noHardware)
        let module = PrototypeBiometricModule(source: source, bundle: BiometricBundle())
        let invalid: [[String: JSONValue]] = [
            [:], ["title": .string(String(repeating: "a", count: 65))],
            ["title": .string("Unlock"), "unknown": .bool(true)],
            ["title": .string("Unlock"), "allowDeviceCredential": .string("true")],
        ]
        for args in invalid {
            let result = await module.call(PlatformCall(callId: "b", call: "biometric.authenticate", args: args))
            guard case .failure(.invalidArgs, _) = result else { return XCTFail("Expected invalid args: \(result)") }
        }
        let wrong = await module.call(PlatformCall(callId: "b", call: "biometric.wrong", args: [:]))
        guard case .failure(.unsupported, _) = wrong else { return XCTFail("Expected unsupported") }
        XCTAssertTrue(source.availabilityPolicies.isEmpty)
        XCTAssertTrue(source.evaluations.isEmpty)
    }

    private func pending(
        _ module: PrototypeBiometricModule,
        source: BiometricSource
    )
        async throws -> Task<PlatformCallResult, Never>
    {
        source.hold = true
        var task: Task<PlatformCallResult, Never>?
        await withCheckedContinuation { ready in
            source.onEvaluate = { ready.resume() }
            task = Task { await module.call(self.call()) }
        }
        // The callback above proves the task is suspended inside evaluate, without sleeps or polling.
        return try XCTUnwrap(task)
    }

    func testBusyPrecedesAvailabilityAndInvalidArgumentsPrecedeBusy() async throws {
        let source = BiometricSource()
        let module = PrototypeBiometricModule(source: source, bundle: BiometricBundle())
        let first = try await pending(module, source: source)
        source.available = .unavailable(.noHardware)
        let second = await module.call(call())
        XCTAssertEqual(second, .failure(.tooManyInFlight, "Biometric authentication already in flight"))
        let invalid = await module.call(PlatformCall(callId: "bad", call: "biometric.authenticate", args: [:]))
        guard case .failure(.invalidArgs, _) = invalid else { return XCTFail("Expected invalid args") }
        XCTAssertEqual(source.availabilityPolicies.count, 1)
        XCTAssertEqual(source.evaluations.count, 1)
        module.stop()
        let result = await first.value
        XCTAssertEqual(result, .failure(.cancelled, "Biometric authentication cancelled"))
    }

    func testStopCancelsExactlyOnceFinishesStreamAndAllowsFreshCall() async throws {
        let source = BiometricSource()
        let module = PrototypeBiometricModule(source: source, bundle: BiometricBundle())
        var events = module.events.makeAsyncIterator()
        let first = try await pending(module, source: source)
        module.stop()
        module.stop()
        XCTAssertEqual(source.invalidations, 1)
        let result = await first.value
        XCTAssertEqual(result, .failure(.cancelled, "Biometric authentication cancelled"))
        let end = await events.next()
        XCTAssertNil(end)
        source.hold = false
        let next = await module.call(call())
        XCTAssertEqual(next, .success(.object([:])))
        module.stop()
        XCTAssertEqual(source.invalidations, 1)
    }

    func testTaskCancellationInvalidatesExactlyOnceAndAllowsFreshCall() async throws {
        let source = BiometricSource()
        let module = PrototypeBiometricModule(source: source, bundle: BiometricBundle())
        let first = try await pending(module, source: source)
        first.cancel()
        let result = await first.value
        XCTAssertEqual(result, .failure(.cancelled, "Biometric authentication cancelled"))
        module.stop()
        module.stop()
        XCTAssertEqual(source.invalidations, 1)
        source.hold = false
        let next = await module.call(call())
        XCTAssertEqual(next, .success(.object([:])))
    }

    func testStoppedCallCannotClearOrCancelItsReplacement() async throws {
        let source = BiometricSource()
        let module = PrototypeBiometricModule(source: source, bundle: BiometricBundle())
        let first = try await pending(module, source: source)
        module.stop()
        let second = try await pending(module, source: source)
        let firstResult = await first.value
        XCTAssertEqual(firstResult, .failure(.cancelled, "Biometric authentication cancelled"))
        first.cancel()
        let busy = await module.call(call())
        XCTAssertEqual(busy, .failure(.tooManyInFlight, "Biometric authentication already in flight"))
        XCTAssertEqual(source.invalidations, 1)
        module.stop()
        let secondResult = await second.value
        XCTAssertEqual(secondResult, .failure(.cancelled, "Biometric authentication cancelled"))
        XCTAssertEqual(source.invalidations, 2)
    }

    func testAlreadyCancelledTaskDoesNotConsultSource() async {
        let source = BiometricSource()
        let module = PrototypeBiometricModule(source: source, bundle: BiometricBundle())
        // The main actor cannot start the task until this synchronous region has cancelled it.
        let task = Task { await module.call(self.call()) }
        task.cancel()
        let result = await task.value
        XCTAssertEqual(result, .failure(.cancelled, "Biometric authentication cancelled"))
        XCTAssertTrue(source.availabilityPolicies.isEmpty)
        XCTAssertTrue(source.evaluations.isEmpty)
        XCTAssertEqual(source.invalidations, 0)
    }

    func testEventStreamIsBoundedAndFreshSubscribersWorkAfterStop() async {
        let source = BiometricSource()
        source.outcomes = Array(repeating: .attemptFailed, count: 12) + [.success]
        let module = PrototypeBiometricModule(source: source, bundle: BiometricBundle())
        let stream = module.events
        _ = await module.call(call())
        module.stop()
        var count = 0
        for await _ in stream {
            count += 1
        }
        XCTAssertEqual(count, 8)
        source.outcomes = [.attemptFailed, .success]
        var fresh = module.events.makeAsyncIterator()
        _ = await module.call(call())
        module.stop()
        let event = await fresh.next()
        XCTAssertEqual(event, PlatformEvent(event: "biometric.attemptFailed", data: .object([:])))
        let end = await fresh.next()
        XCTAssertNil(end)
    }

    func testUnexpectedAvailabilityFailureDoesNotEvaluate() async {
        let source = BiometricSource()
        source.available = .platformError
        let result = await PrototypeBiometricModule(source: source, bundle: BiometricBundle()).call(call())
        XCTAssertEqual(result, .failure(.platformError, "Biometric authentication failed"))
        XCTAssertTrue(source.evaluations.isEmpty)
    }

    func testCancelledAndUnexpectedOutcomes() async {
        for outcome in [PrototypeBiometricOutcome.cancelled, .platformError] {
            let source = BiometricSource()
            source.outcomes = [outcome]
            let result = await PrototypeBiometricModule(source: source, bundle: BiometricBundle()).call(call())
            XCTAssertEqual(
                result,
                outcome == .cancelled ? .failure(.cancelled, "Biometric authentication cancelled") :
                    .failure(.platformError, "Biometric authentication failed")
            )
        }
    }

    func testLocalAuthenticationErrorMapping() {
        #if canImport(LocalAuthentication)
            let cases: [(LAError.Code, PrototypeBiometricOutcome)] = [
                (.authenticationFailed, .attemptFailed), (.userCancel, .cancelled), (.userFallback, .cancelled),
                (.systemCancel, .cancelled), (.appCancel, .cancelled), (.notInteractive, .cancelled),
                (.biometryNotEnrolled, .unavailable(.notEnrolled)), (.biometryNotAvailable, .unavailable(.noHardware)),
                (.biometryLockout, .unavailable(.lockout)), (.passcodeNotSet, .unavailable(.passcodeNotSet)),
                (.invalidContext, .platformError),
            ]
            for (code, expected) in cases {
                XCTAssertEqual(PrototypeBiometricOutcome.fromLocalAuthenticationErrorCode(code.rawValue), expected)
            }
        #endif
        XCTAssertEqual(PrototypeBiometricOutcome.fromLocalAuthenticationErrorCode(Int.max), .platformError)
    }

    func testRegistryFactoriesAdvertiseOnlyWhenModuleIsSupplied() {
        let services = BiometricRegistryServices()
        for feedback in [false, true] {
            for supplied in [false, true] {
                let source = supplied ? BiometricSource() : nil
                let registry = feedback ? PrototypePlatformRegistry.feedbackModules(
                    haptics: services, sound: services, connectivity: services, links: services, settings: services,
                    bundle: BiometricBundle(), biometric: source
                ) : PrototypePlatformRegistry.systemModules(
                    clipboard: services, connectivity: services, links: services, settings: services,
                    bundle: BiometricBundle(), biometric: source
                )
                XCTAssertEqual(registry.modules["biometric"] != nil, supplied)
                XCTAssertEqual(registry.capabilities.contains("prototype_platform_biometric_v1"), supplied)
                XCTAssertEqual(
                    PrototypeAgentProtocol.advertisedCapabilities(registryCapabilities: registry.capabilities)
                        .contains("prototype_platform_biometric_v1"),
                    supplied
                )
            }
        }
    }

    func testFixtureThroughSessionAndDriver() async throws {
        let url = PrototypeSpecFixtures.directory.appendingPathComponent("valid/platform-biometric.json")
        let spec = try JSONDecoder().decode(PrototypeSpec.self, from: Data(contentsOf: url))
        let action = try XCTUnwrap(spec.root.children?[1].onTap?.first)
        for reason in [nil] + PrototypeBiometricUnavailableReason.allCases.map(Optional.some) {
            let source = BiometricSource()
            let bundle = BiometricBundle()
            if let reason {
                source.available = reason == .missingUsageDescription ? .ready(usesFaceID: true) : .unavailable(reason)
            } else { source.outcomes = [.attemptFailed, .attemptFailed, .success] }
            let module = PrototypeBiometricModule(source: source, bundle: bundle)
            let registry = PrototypePlatformRegistry(modules: [module])
            let driver = PrototypePlatformDriver(registry: registry, clock: LocationClock())
            var session = PrototypeSession()
            session.show(spec)
            _ = session.run([action])
            XCTAssertEqual(session.state["authStatus"], .string("loading"))
            var completionEvents: [PrototypeEvent] = []
            driver.onComplete = { id, result, duration in
                completionEvents += session.completePlatformCall(id, result, durationMs: duration)
            }
            var delivered = 0
            var eventWaiter: CheckedContinuation<Void, Never>?
            driver.onEvent = { event in
                do {
                    _ = try session.deliverPlatformEvent(event.event, data: event.data)
                } catch {
                    XCTFail("Failed to deliver biometric event: \(error)")
                }
                delivered += 1
                if delivered == 2 { eventWaiter?.resume(); eventWaiter = nil }
            }
            driver.subscribe()
            driver.perform(session.takePlatformCommands())
            await driver.settled()
            if reason == nil, delivered < 2 {
                await withCheckedContinuation { eventWaiter = $0 }
            }
            XCTAssertEqual(session.state["authStatus"], .string(reason == nil ? "success" : "error"))
            XCTAssertEqual(session.state["unlocked"], .bool(reason == nil))
            XCTAssertEqual(session.state["failures"], .number(reason == nil ? 2 : 0))
            if let reason {
                XCTAssertEqual(delivered, 0)
                XCTAssertEqual(source.evaluations.count, 0)
                let completion = try XCTUnwrap(completionEvents.first { $0.name == "prototype_platform" })
                let error = completion.payload.objectFields?["error"]?.objectFields
                XCTAssertEqual(error?["code"], .string("unavailable"))
                XCTAssertEqual(error?["reason"], .string(reason.rawValue))
                XCTAssertEqual(error?["message"], .string(reason.rawValue))
            }
            driver.stopEvents()
        }
    }
}
