@testable import AutoMobilePrototypeAgentCore
import XCTest
#if canImport(Network)
    import Network
#endif

@MainActor
final class PrototypeLibraryNetworkTests: XCTestCase {
    func testSettingDefaultsOffAndPersistsBothDirectionsAcrossInstances() {
        let store = MemoryNetworkSettingStore()
        let setting = PrototypeLibraryNetworkSwitch(store: store)
        XCTAssertFalse(setting.enabled)
        XCTAssertTrue(store.values.isEmpty)
        setting.enabled = true
        XCTAssertEqual(store.values, ["allowImportedPrototypeNetwork": true])
        let restored = PrototypeLibraryNetworkSwitch(store: store)
        XCTAssertTrue(restored.enabled)
        restored.enabled = false
        XCTAssertFalse(PrototypeLibraryNetworkSwitch(store: store).enabled)
        XCTAssertEqual(store.values, ["allowImportedPrototypeNetwork": false])
    }

    func testDisabledRequestsReachPrototypeErrorPathWithoutConstructingOrTouchingTransport() async throws {
        for via in ["device", "host"] {
            let resolver = FakeHostResolver()
            let connector = FakePinnedConnector([])
            var constructions = 0
            let configuration = PrototypeLibraryNetwork
                .configuration(gate: PrototypeLibraryNetworkGate(), allowsCleartext: true) { cleartext in
                    constructions += 1
                    return self.pinnedConfiguration(resolver, connector, cleartext: cleartext)
                }
            let spec = try requestSpec(via: via)
            var session = PrototypeSession()
            session.show(spec)
            let clock = ManualRequestClock()
            let driver = configuration.driver(clock: clock)
            var events: [PrototypeEvent] = []
            var response: PrototypeRequestResponse?
            driver.onComplete = { id, result in
                response = result
                events += session.completeRequest(id, result)
            }
            _ = session.run(spec.root.onTap ?? [])
            driver.perform(session.takeRequestCommands())
            await driver.settled()
            XCTAssertEqual(response, .failed(
                .init(.blockedDestination, "Network is disabled for imported prototypes."), durationMs: 0
            ))
            XCTAssertEqual(session.state["status"], .string("error"))
            XCTAssertTrue(events.contains { $0.name == "requestFailed" && $0.kind == .emitted })
            XCTAssertEqual(constructions, 0)
            XCTAssertTrue(resolver.requestedHosts.isEmpty)
            XCTAssertTrue(connector.dials.isEmpty)
            XCTAssertTrue(clock.handles.isEmpty)
        }
    }

    func testFactoryForwardsCleartextAndUsesPinnedClientForBothRoutes() async throws {
        for cleartext in [false, true] {
            for via in [PrototypeRequestVia.device, .host] {
                let resolver = FakeHostResolver(["192.168.1.4", "192.168.1.5"])
                let connector = FakePinnedConnector([FakePinnedConnection(address: "192.168.1.4")])
                var flags: [Bool] = []
                let configuration = PrototypeLibraryNetwork.configuration(
                    gate: PrototypeLibraryNetworkGate(enabled: true),
                    allowsCleartext: cleartext
                ) {
                    flags.append($0)
                    return self.pinnedConfiguration(resolver, connector, cleartext: $0)
                }
                let scheme = cleartext ? "http" : "https"
                let response = await perform(configuration, url: "\(scheme)://lan.example/", via: via)
                XCTAssertEqual(
                    response,
                    .received(status: 200, headers: ["content-length": "2"], body: .string("ok"), durationMs: 0)
                )
                XCTAssertEqual(flags, [cleartext])
                XCTAssertEqual(resolver.requestedHosts, ["lan.example"])
                // Only a checked address is dialled; a second lookup or second answer is not used.
                XCTAssertEqual(connector.dials, [.init(
                    address: "192.168.1.4", port: cleartext ? 80 : 443,
                    tlsServerName: cleartext ? nil : "lan.example"
                )])
            }
        }
    }

    func testFactoryRetainsPinnedDestinationPolicy() async throws {
        // Detailed normalization and range parity stay in PrototypeEgressPolicyParityTests.
        let blocked = ["127.0.0.1", "[::1]", "169.254.1.2", "[fe80::1]", "10.0.2.2"]
            .map { "https://\($0)/" } + (3000 ... 3010).map { "https://192.168.1.4:\($0)/" } +
            ["https://192.168.1.4:8765/"]
        for url in blocked {
            let resolver = FakeHostResolver()
            let connector = FakePinnedConnector([])
            let result = await perform(enabled(resolver, connector), url: url)
            guard case let .failed(error, _) = result else { return XCTFail("Allowed \(url)") }
            XCTAssertEqual(error.code, .blockedDestination, url)
            XCTAssertTrue(connector.dials.isEmpty, url)
            XCTAssertTrue(resolver.requestedHosts.isEmpty, url)
        }
        for address in ["10.1.2.3", "172.16.1.4", "192.168.1.4"] {
            let connector = FakePinnedConnector([FakePinnedConnection(address: address)])
            let response = await perform(enabled(FakeHostResolver(), connector), url: "https://\(address)/")
            guard case .received = response else { return XCTFail("Refused LAN \(address)") }
            XCTAssertEqual(connector.dials.map(\.address), [address])
        }
    }

    func testFactoryChecksEveryDNSAnswerBeforeDialling() async {
        let connector = FakePinnedConnector([])
        let response = await perform(enabled(FakeHostResolver(["8.8.8.8", "127.0.0.1"]), connector))
        guard case let .failed(error, _) = response else { return XCTFail("Allowed mixed DNS answers") }
        XCTAssertEqual(error.code, .blockedDestination)
        XCTAssertTrue(connector.dials.isEmpty)
    }

    func testFactoryRechecksRedirectAndRefusesHTTPSDowngradeEvenInDev() async {
        for location in ["https://127.0.0.1/", "http://lan.example/"] {
            let resolver = FakeHostResolver()
            let connector = FakePinnedConnector([FakePinnedConnection(
                "HTTP/1.1 302 Found\r\nLocation: \(location)\r\n\r\n"
            )])
            let configuration = PrototypeLibraryNetwork.configuration(
                gate: PrototypeLibraryNetworkGate(enabled: true),
                allowsCleartext: true
            ) {
                self.pinnedConfiguration(resolver, connector, cleartext: $0)
            }
            let response = await perform(configuration)
            guard case let .failed(error, _) = response else { return XCTFail("Followed \(location)") }
            XCTAssertEqual(error.code, .blockedDestination)
            XCTAssertEqual(connector.dials.count, 1)
            XCTAssertEqual(resolver.requestedHosts, ["public.example"])
        }
    }

    func testFactoryRefusesCleartextOutsideDev() async {
        let resolver = FakeHostResolver()
        let connector = FakePinnedConnector([])
        let response = await perform(enabled(resolver, connector), url: "http://lan.example/")
        guard case let .failed(error, _) = response else { return XCTFail("Allowed cleartext") }
        XCTAssertEqual(error.code, .blockedDestination)
        XCTAssertTrue(resolver.requestedHosts.isEmpty)
        XCTAssertTrue(connector.dials.isEmpty)
    }

    func testLiveSwitchUpdatesExistingDriverWithoutLosingPrototypeState() async throws {
        let setting = PrototypeLibraryNetworkSwitch(store: MemoryNetworkSettingStore())
        let connector = FakePinnedConnector([FakePinnedConnection()])
        let resolver = FakeHostResolver()
        func configuration() -> PrototypeNetworkConfiguration {
            PrototypeLibraryNetwork.configuration(gate: setting.gate, allowsCleartext: false) {
                self.pinnedConfiguration(resolver, connector, cleartext: $0)
            }
        }
        let spec = try requestSpec(via: "device")
        var session = PrototypeSession()
        session.show(spec)
        _ = session.change(key: "count", value: .number(7))
        let driver = configuration().driver(clock: ManualRequestClock())
        driver.onComplete = { id, result in _ = session.completeRequest(id, result) }
        for value in [false, true, false] {
            setting.enabled = value
            _ = session.run(spec.root.onTap ?? [])
            driver.perform(session.takeRequestCommands())
            await driver.settled()
            XCTAssertEqual(session.state["status"], .string(value ? "success" : "error"))
            XCTAssertEqual(session.state["count"], .number(7))
            XCTAssertTrue(session.isShown)
        }
        XCTAssertEqual(connector.dials.count, 1)
        XCTAssertEqual(resolver.requestedHosts, ["public.example"])
    }

    func testOffCancelsPinnedConnectionAndReturnsDisabled() async throws {
        let setting = PrototypeLibraryNetworkSwitch(store: MemoryNetworkSettingStore())
        setting.enabled = true
        let started = FakePinnedSignal()
        let connection = FakePinnedConnection()
        connection.pause = FakePinnedSignal()
        connection.onReceive = { started.release() }
        let configuration = enabledConfiguration(setting, connector: FakePinnedConnector([connection]))
        let task = Task { try await configuration.device.perform(pinnedRequest()) }
        await started.wait()
        setting.enabled = false
        do { _ = try await task.value; XCTFail("Revoked request succeeded") }
        catch { XCTAssertEqual(error as? PrototypeHttpFailure, PrototypeLibraryGatedClient.disabled) }
        XCTAssertTrue(connection.cancelled)
    }

    func testLateSuccessIsDroppedAfterOffAndQuickOffOn() async throws {
        for reenable in [false, true] {
            let gate = PrototypeLibraryNetworkGate(enabled: true)
            let late = LateLibraryClient()
            let configuration = PrototypeLibraryNetwork.configuration(gate: gate, allowsCleartext: false) { _ in
                PrototypeNetworkConfiguration(device: late)
            }
            let task = Task { try await configuration.device.perform(pinnedRequest()) }
            await late.started.wait()
            gate.setEnabled(false)
            if reenable { gate.setEnabled(true) }
            late.release.release()
            do { _ = try await task.value; XCTFail("Stale success escaped") }
            catch { XCTAssertEqual(error as? PrototypeHttpFailure, PrototypeLibraryGatedClient.disabled) }
            await late.finished.wait()
            if reenable {
                let response = try await configuration.device.perform(pinnedRequest())
                XCTAssertEqual(response.status, 200)
            }
        }
    }

    func testLocalNetworkDenialPersistsOffAndReenableClearsExplanation() async throws {
        let setting = PrototypeLibraryNetworkSwitch(store: MemoryNetworkSettingStore())
        setting.enabled = true
        let connector = FakePinnedConnector(outcomes: [.failure(PrototypeLocalNetworkDenied())])
        let configuration = enabledConfiguration(setting, connector: connector)
        do {
            _ = try await configuration.device.perform(pinnedRequest("https://192.168.1.4/"))
            XCTFail("Permission denial succeeded")
        } catch {
            XCTAssertEqual(
                (error as? PrototypeHttpFailure)?.error,
                .init(.network, PrototypeLocalNetworkDenied.message)
            )
        }
        XCTAssertFalse(setting.enabled)
        XCTAssertNil(setting.gate.snapshot())
        XCTAssertTrue(setting.localNetworkDenied)
        setting.enabled = true
        XCTAssertFalse(setting.localNetworkDenied)
        // A public-host success cannot manufacture a local-network denial.
        let publicClient = enabledConfiguration(setting, connector: FakePinnedConnector([FakePinnedConnection()]))
        _ = try await publicClient.device.perform(pinnedRequest())
        XCTAssertTrue(setting.enabled)
        XCTAssertFalse(setting.localNetworkDenied)
    }

    func testPinnedDenialNotifiesOnceWithoutRetryingAddresses() async {
        let notified = FakePinnedSignal()
        let connector = FakePinnedConnector(outcomes: [.failure(PrototypeLocalNetworkDenied())])
        let client = PrototypePinnedHttpClient(
            resolver: FakeHostResolver(["192.168.1.4", "192.168.1.5"]), connector: connector,
            deadlines: FakePinnedDeadline(), nowMs: { 0 }, onLocalNetworkDenied: { notified.release() }
        )
        do { _ = try await client.perform(pinnedRequest()); XCTFail("Permission denial succeeded") }
        catch { XCTAssertEqual((error as? PrototypeHttpFailure)?.error.message, PrototypeLocalNetworkDenied.message) }
        XCTAssertEqual(notified.releaseCount, 1)
        XCTAssertEqual(connector.dials.count, 1)
    }

    #if canImport(Network)
        func testPolicyDeniedKeepsWaitingForPermission() {
            var policy = PrototypeNWWaitPolicy()
            guard case .keepWaiting = policy.observe(.waiting(.dns(-65570))) else {
                return XCTFail("PolicyDenied must wait for the prompt")
            }
            XCTAssertTrue(policy.awaitingPermission)
        }

        func testReadyAfterPermissionPromptClearsWait() {
            var policy = PrototypeNWWaitPolicy()
            _ = policy.observe(.waiting(.dns(-65570)))
            guard case .ready = policy.observe(.ready) else { return XCTFail("Allow must proceed") }
            XCTAssertFalse(policy.awaitingPermission)
        }

        func testOtherWaitingErrorsRejectImmediately() {
            var policy = PrototypeNWWaitPolicy()
            guard case let .reject(error) = policy.observe(.waiting(.posix(.ENETUNREACH))) else {
                return XCTFail("Unreachable must reject")
            }
            XCTAssertEqual((error as? POSIXError)?.code, .ENETUNREACH)
            XCTAssertFalse(policy.awaitingPermission)
            guard case .reject = policy.observe(.failed(.dns(-65570))) else {
                return XCTFail("Failed connections must reject even for PolicyDenied")
            }
        }

        func testTeardownWhileAwaitingReportsDenialExactlyOnce() {
            var policy = PrototypeNWWaitPolicy()
            _ = policy.observe(.waiting(.dns(-65570)))
            var reports = 0
            for _ in 0 ..< 3 {
                if policy.teardown() { reports += 1 }
            }
            XCTAssertEqual(reports, 1)
            guard case .none = policy.observe(.waiting(.dns(-65570))) else {
                return XCTFail("Late callbacks must not reopen a stopped connection")
            }
            XCTAssertFalse(policy.teardown())
        }

        func testTeardownAfterReadyDoesNotReportDenial() {
            var policy = PrototypeNWWaitPolicy()
            _ = policy.observe(.waiting(.dns(-65570)))
            _ = policy.observe(.ready)
            XCTAssertFalse(policy.teardown())
            XCTAssertFalse(policy.teardown())
        }

        func testProductionConfigurationWhileOffReturnsDisabled() async {
            let setting = PrototypeLibraryNetworkSwitch(store: MemoryNetworkSettingStore())
            let configuration = PrototypeLibraryNetwork.configuration(networkSwitch: setting, allowsCleartext: true)
            // The production factory must stay behind the gate: even this invalid destination
            // returns disabled rather than reaching URL validation, DNS or a real connection.
            do {
                _ = try await configuration.device.perform(pinnedRequest("invalid URL"))
                XCTFail("Disabled request succeeded")
            } catch {
                XCTAssertEqual(error as? PrototypeHttpFailure, PrototypeLibraryGatedClient.disabled)
            }
            XCTAssertFalse(setting.localNetworkDenied)
        }
    #endif

    func testDenyLocalNetworkIgnoresOffSwitchAndRevokesOnSwitch() {
        let store = MemoryNetworkSettingStore()
        let setting = PrototypeLibraryNetworkSwitch(store: store)
        setting.denyLocalNetwork()
        XCTAssertFalse(setting.enabled)
        XCTAssertFalse(setting.localNetworkDenied)
        XCTAssertTrue(store.values.isEmpty)
        setting.enabled = true
        setting.enabled = false
        setting.denyLocalNetwork()
        XCTAssertFalse(setting.localNetworkDenied)
        setting.enabled = true
        setting.denyLocalNetwork()
        XCTAssertFalse(setting.enabled)
        XCTAssertTrue(setting.localNetworkDenied)
        XCTAssertEqual(store.values[PrototypeLibraryNetworkSwitch.key], false)
        setting.denyLocalNetwork()
        XCTAssertTrue(setting.localNetworkDenied)
    }

    private func enabledConfiguration(
        _ setting: PrototypeLibraryNetworkSwitch, connector: FakePinnedConnector
    )
        -> PrototypeNetworkConfiguration
    {
        PrototypeLibraryNetwork.configuration(
            gate: setting.gate, allowsCleartext: false,
            onLocalNetworkDenied: { setting.denyLocalNetwork() },
            pinned: { _ in self.pinnedConfiguration(FakeHostResolver(), connector) }
        )
    }

    private func requestSpec(via: String) throws -> PrototypeSpec {
        try JSONDecoder().decode(PrototypeSpec.self, from: Data("""
        {"id":"library-network","window":{"placement":{"type":"fullscreen"}},
         "state":{"status":"idle","count":0},"root":{"type":"button","label":"Go","onTap":[
         {"type":"request","url":"https://public.example/","via":"\(via)","statusKey":"status",
          "onError":[{"type":"emit","name":"requestFailed"}]}]}}
        """.utf8))
    }

    private nonisolated func pinnedConfiguration(
        _ resolver: FakeHostResolver, _ connector: FakePinnedConnector, cleartext: Bool = false
    )
        -> PrototypeNetworkConfiguration
    {
        PrototypeNetworkConfiguration(device: PrototypePinnedHttpClient(
            resolver: resolver, connector: connector, deadlines: FakePinnedDeadline(),
            allowsCleartext: cleartext, nowMs: { 0 }
        ))
    }

    private func enabled(
        _ resolver: FakeHostResolver, _ connector: FakePinnedConnector
    )
        -> PrototypeNetworkConfiguration
    {
        PrototypeLibraryNetwork
            .configuration(gate: PrototypeLibraryNetworkGate(enabled: true), allowsCleartext: false) {
                self.pinnedConfiguration(resolver, connector, cleartext: $0)
            }
    }

    private func perform(
        _ configuration: PrototypeNetworkConfiguration,
        url: String = "https://public.example/", via: PrototypeRequestVia = .device
    )
        async -> PrototypeRequestResponse?
    {
        let driver = configuration.driver(clock: ManualRequestClock())
        var response: PrototypeRequestResponse?
        driver.onComplete = { _, result in response = result }
        driver.perform([.start(PrototypeRequestJob(
            requestId: "r", prototypeId: "p", via: via, method: .get, url: url,
            headers: [:], body: nil, timeoutMs: 1000
        ))])
        await driver.settled()
        return response
    }
}

@MainActor
private final class MemoryNetworkSettingStore: PrototypeLibraryNetworkSettingStore {
    var values: [String: Bool] = [:]
    func bool(forKey key: String) -> Bool { values[key] ?? false }
    func set(_ value: Bool, forKey key: String) { values[key] = value }
}

/// Deliberately ignores cancellation to exercise delivery of an obsolete transport result.
private actor LateLibraryClient: PrototypeHttpClient {
    nonisolated let started = FakePinnedSignal()
    nonisolated let release = FakePinnedSignal()
    nonisolated let finished = FakePinnedSignal()
    func perform(_: PrototypeHttpRequest) async throws -> PrototypeHttpResponse {
        started.release()
        await release.wait()
        finished.release()
        return PrototypeHttpResponse(status: 200, headers: [:], body: Data(), durationMs: 0)
    }
}
