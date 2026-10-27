@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypePinnedHttpClientTests: XCTestCase {
    func testAllAnswersMustPassBeforeConnecting() async {
        let resolver = FakeHostResolver(["8.8.8.8", "127.0.0.1"])
        let connector = FakePinnedConnector([])
        await failure(pinnedRequest(), resolver: resolver, connector: connector, code: .blockedDestination)
        XCTAssertTrue(connector.dials.isEmpty)
    }

    func testExactlyOneResolutionAndPinnedDial() async throws {
        let resolver = FakeHostResolver()
        let connector = FakePinnedConnector([FakePinnedConnection()])
        let response = try await client(resolver, connector).perform(pinnedRequest("https://public.example:8443/"))
        XCTAssertEqual(response.body, Data("ok".utf8))
        XCTAssertEqual(resolver.requestedHosts, ["public.example"])
        XCTAssertEqual(connector.dials, [.init(address: "8.8.8.8", port: 8443, tlsServerName: "public.example")])
    }

    func testLiteralsAndPrivatePortsAndCleartext() async throws {
        let resolver = FakeHostResolver()
        let connector = FakePinnedConnector([FakePinnedConnection(address: "192.168.1.1")])
        _ = try await client(resolver, connector, cleartext: true)
            .perform(pinnedRequest("http://192.168.1.1:8080/"))
        XCTAssertEqual(connector.dials, [.init(address: "192.168.1.1", port: 8080, tlsServerName: nil)])
        XCTAssertTrue(resolver.requestedHosts.isEmpty)
        for url in ["https://10.0.2.2/", "https://192.168.1.1:3000/", "http://public.example/"] {
            await failure(pinnedRequest(url), resolver: resolver, code: .blockedDestination)
        }
    }

    func testRemoteMustMatchAndMustBeKnown() async {
        for address: String? in [nil, "1.1.1.1"] {
            let connection = FakePinnedConnection(address: address)
            await failure(pinnedRequest(), connector: FakePinnedConnector([connection]), code: .blockedDestination)
            XCTAssertTrue(connection.cancelled)
            XCTAssertTrue(connection.sent.isEmpty)
        }
    }

    func testCanonicalIPv6PeerComparison() async throws {
        let connection = FakePinnedConnection(address: "2606:4700:0:0:0:0:0:1")
        _ = try await client(FakeHostResolver(), FakePinnedConnector([connection]))
            .perform(pinnedRequest("https://[2606:4700::1]/"))
        XCTAssertTrue(connection.sent.contains("Host: [2606:4700::1]"))
    }

    func testNAT64PeerMustEmbedTheCheckedIPv4() async throws {
        XCTAssertTrue(PrototypePinnedHttpClient.sameAddress("64:ff9b::808:808", "8.8.8.8"))
        XCTAssertTrue(PrototypePinnedHttpClient.sameAddress("8.8.8.8", "64:ff9b::8.8.8.8"))
        XCTAssertFalse(PrototypePinnedHttpClient.sameAddress("64:ff9b::808:809", "8.8.8.8"))
        XCTAssertFalse(PrototypePinnedHttpClient.sameAddress("64:ff9b:1::808:808", "8.8.8.8"))
        XCTAssertFalse(PrototypePinnedHttpClient.sameAddress("2001:db8::808:808", "8.8.8.8"))
        let connection = FakePinnedConnection(address: "64:ff9b::808:808")
        _ = try await client(FakeHostResolver(["8.8.8.8"]), FakePinnedConnector([connection]))
            .perform(pinnedRequest())
        let other = FakePinnedConnection(address: "64:ff9b::101:101")
        await failure(pinnedRequest(), connector: FakePinnedConnector([other]), code: .blockedDestination)
        XCTAssertTrue(other.cancelled)
    }

    func testConnectFallbackNeverResolvesAgain() async throws {
        let resolver = FakeHostResolver(["8.8.8.8", "1.1.1.1"])
        let connector = FakePinnedConnector(outcomes: [
            .failure(URLError(.cannotConnectToHost)), .success(FakePinnedConnection(address: "1.1.1.1")),
        ])
        _ = try await client(resolver, connector).perform(pinnedRequest())
        XCTAssertEqual(connector.dials.map(\.address), ["8.8.8.8", "1.1.1.1"])
        XCTAssertEqual(resolver.requestedHosts.count, 1)
        await failure(pinnedRequest(), connector: FakePinnedConnector([]), code: .connectionRefused)
    }

    func testTLSFailureDoesNotTryAnotherAddress() async {
        let resolver = FakeHostResolver(["8.8.8.8", "1.1.1.1"])
        let connector = FakePinnedConnector(outcomes: [
            .failure(URLError(.serverCertificateUntrusted)), .success(FakePinnedConnection(address: "1.1.1.1")),
        ])
        await failure(pinnedRequest(), resolver: resolver, connector: connector, code: .network)
        XCTAssertEqual(connector.dials.map(\.address), ["8.8.8.8"])
    }

    func testInvalidURLHeadersAndJSONNull() async {
        await failure(pinnedRequest("/relative"), code: .invalidURL)
        await failure(pinnedRequest(headers: ["Host": "evil"]), code: .invalidRequest)
        await failure(pinnedRequest(), connector: FakePinnedConnector([
            FakePinnedConnection("HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nnull"),
        ]), code: .invalidResponse)
    }

    func testTimeoutCancelsLiveConnection() async {
        let deadlines = FakePinnedDeadline()
        let connection = FakePinnedConnection()
        connection.onReceive = { deadlines.fire() }
        await failure(
            pinnedRequest(),
            connector: FakePinnedConnector([connection]),
            deadlines: deadlines,
            code: .timeout
        )
        XCTAssertTrue(connection.cancelled)
    }

    func testCallerCancellation() async {
        let connection = FakePinnedConnection()
        let transport = client(FakeHostResolver(), FakePinnedConnector([connection]))
        let task = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            return try await transport.perform(pinnedRequest())
        }
        do { _ = try await task.value; XCTFail("Completed cancelled request") }
        catch { XCTAssertEqual((error as? PrototypeHttpFailure)?.error.code, .cancelled) }
    }

    func testCallerCancellationDuringIOCancelsConnection() async {
        let entered = FakePinnedSignal()
        let connection = FakePinnedConnection()
        connection.pause = FakePinnedSignal()
        connection.onReceive = { entered.release() }
        let transport = client(FakeHostResolver(), FakePinnedConnector([connection]))
        let task = Task { try await transport.perform(pinnedRequest()) }
        await entered.wait()
        task.cancel()
        do { _ = try await task.value; XCTFail("Completed cancelled I/O") }
        catch { XCTAssertEqual((error as? PrototypeHttpFailure)?.error.message, "Request was cancelled.") }
        XCTAssertTrue(connection.cancelled)
    }

    func testLegacyPublicLiteralDialsCanonicalIPWithoutDNS() async throws {
        let resolver = FakeHostResolver()
        let connector = FakePinnedConnector([FakePinnedConnection()])
        _ = try await client(resolver, connector).perform(pinnedRequest("https://134744072/"))
        XCTAssertTrue(resolver.requestedHosts.isEmpty)
        XCTAssertEqual(connector.dials.first?.address, "8.8.8.8")
    }

    func testEmptyAndFailedResolutionNeverConnect() async {
        let connector = FakePinnedConnector([])
        await failure(pinnedRequest(), resolver: FakeHostResolver([]), connector: connector, code: .blockedDestination)
        await failure(pinnedRequest(), resolver: FailingPinnedResolver(), connector: connector, code: .network)
        XCTAssertTrue(connector.dials.isEmpty)
    }

    func testNonSuccessNeverRequestsBody() async throws {
        let connection = FakePinnedConnection(chunks: [
            "HTTP/1.1 503 Error\r\nContent-Length: 100000\r\n\r\n",
            "must not be read",
        ])
        let response = try await client(FakeHostResolver(), FakePinnedConnector([connection])).perform(pinnedRequest())
        XCTAssertEqual(response.status, 503)
        XCTAssertEqual(response.body, Data())
        XCTAssertEqual(connection.receiveCount, 1)
    }

    #if canImport(Network)
        func testPinnedConfigurationConstructs() { _ = PrototypeNetworkConfiguration.pinned() }
    #endif

    private func client(
        _ resolver: any HostResolving, _ connector: any PrototypePinnedConnecting, cleartext: Bool = false
    )
        -> PrototypePinnedHttpClient
    {
        PrototypePinnedHttpClient(
            resolver: resolver,
            connector: connector,
            deadlines: FakePinnedDeadline(),
            allowsCleartext: cleartext,
            nowMs: { 123 }
        )
    }

    private func failure(
        _ request: PrototypeHttpRequest, resolver: any HostResolving = FakeHostResolver(),
        connector: any PrototypePinnedConnecting = FakePinnedConnector([]),
        deadlines: any PrototypeDNSDeadlineScheduling = FakePinnedDeadline(), code: PrototypeRequestErrorCode
    )
        async
    {
        do {
            _ = try await PrototypePinnedHttpClient(
                resolver: resolver,
                connector: connector,
                deadlines: deadlines,
                nowMs: { 100 }
            ).perform(request)
            XCTFail("Unexpected success")
        } catch {
            let failure = error as? PrototypeHttpFailure
            XCTAssertEqual(failure?.error.code, code)
            XCTAssertEqual(failure?.durationMs, 0)
        }
    }
}

private struct FailingPinnedResolver: HostResolving {
    func addresses(for _: String) async throws -> [String] { throw URLError(.cannotFindHost) }
}
