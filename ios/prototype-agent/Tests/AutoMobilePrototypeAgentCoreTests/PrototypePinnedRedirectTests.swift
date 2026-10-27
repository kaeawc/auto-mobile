@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypePinnedRedirectTests: XCTestCase {
    func testFetchRedirectMethodsAndEntities() async throws {
        for (status, method, next) in [
            (302, PrototypeRequestMethod.post, "GET"),
            (303, .put, "GET"),
            (303, .head, "HEAD"),
            (307, .post, "POST"),
        ] {
            let first = redirect(status, "/next")
            let second = FakePinnedConnection()
            let resolver = FakeHostResolver()
            let connector = FakePinnedConnector([first, second])
            let request = pinnedRequest(
                method: method,
                headers: [
                    "cOnTeNt-TyPe": "text/plain",
                    "Content-Encoding": "identity",
                    "Content-Language": "en",
                    "Content-Location": "/body",
                ],
                body: .string("body")
            )
            _ = try await transport(resolver, connector).perform(request)
            XCTAssertTrue(second.sent.hasPrefix("\(next) /next HTTP/1.1"), second.sent)
            if next == "GET" {
                XCTAssertFalse(second.sent.lowercased().contains("content-"), second.sent)
                XCTAssertFalse(second.sent.contains("body"))
            }
            if next == "POST" { XCTAssertTrue(second.sent.hasSuffix("body")) }
            XCTAssertEqual(resolver.requestedHosts, ["public.example", "public.example"])
        }
    }

    func testOriginCredentialRules() async throws {
        for location in ["/next", "https://other.example/next", "https://public.example:8443/next"] {
            let second = FakePinnedConnection()
            let connector = FakePinnedConnector([redirect(301, location), second])
            _ = try await transport(FakeHostResolver(), connector)
                .perform(pinnedRequest(headers: ["aUtHoRiZaTiOn": "secret"]))
            XCTAssertEqual(second.sent.contains("secret"), location == "/next")
        }
    }

    func testDowngradeAndSixthRedirectAreBlocked() async {
        await blocked(FakeHostResolver(), FakePinnedConnector([redirect(302, "http://other.example/")]))
        let resolver = FakeHostResolver()
        let connector = FakePinnedConnector((0 ..< 6).map { _ in redirect(302, "/next") })
        await blocked(resolver, connector)
        XCTAssertEqual(resolver.requestedHosts.count, 6)
    }

    func testRedirectResolvesNewHostAndBlocksLoopback() async {
        let resolver = RedirectResolver()
        let connector = FakePinnedConnector([redirect(308, "https://blocked.example/")])
        await blocked(resolver, connector)
        XCTAssertEqual(resolver.hosts, ["public.example", "blocked.example"])
        XCTAssertEqual(connector.dials.count, 1)
    }

    func testOneTotalDeadlineAcrossRedirects() async {
        let deadlines = FakePinnedDeadline()
        let first = redirect(302, "/next")
        let second = FakePinnedConnection()
        second.onReceive = { deadlines.fire() }
        let connector = FakePinnedConnector([first, second])
        do {
            _ = try await PrototypePinnedHttpClient(
                resolver: FakeHostResolver(),
                connector: connector,
                deadlines: deadlines
            ).perform(pinnedRequest())
            XCTFail("Completed expired redirect")
        } catch { XCTAssertEqual((error as? PrototypeHttpFailure)?.error.message, "Request timed out after 1000ms.") }
        XCTAssertEqual(deadlines.scheduleCount, 1)
        XCTAssertEqual(connector.dials.count, 2)
        XCTAssertTrue(first.cancelled)
        XCTAssertTrue(second.cancelled)
    }

    func testRedirectWithoutLocationIsReturned() async throws {
        let connector = FakePinnedConnector([FakePinnedConnection("HTTP/1.1 302 Found\r\n\r\n")])
        let response = try await transport(FakeHostResolver(), connector).perform(pinnedRequest())
        XCTAssertEqual(response.status, 302)
    }

    private func redirect(_ status: Int, _ location: String) -> FakePinnedConnection {
        FakePinnedConnection("HTTP/1.1 \(status) Redirect\r\nLocation: \(location)\r\n\r\n")
    }

    private func transport(
        _ resolver: any HostResolving,
        _ connector: any PrototypePinnedConnecting
    )
        -> PrototypePinnedHttpClient
    {
        PrototypePinnedHttpClient(resolver: resolver, connector: connector, deadlines: FakePinnedDeadline())
    }

    private func blocked(_ resolver: any HostResolving, _ connector: any PrototypePinnedConnecting) async {
        do {
            _ = try await transport(resolver, connector).perform(pinnedRequest()); XCTFail("Followed blocked redirect")
        } catch { XCTAssertEqual((error as? PrototypeHttpFailure)?.error.code, .blockedDestination) }
    }
}

private final class RedirectResolver: HostResolving, @unchecked Sendable {
    private let lock = NSLock()
    private var names: [String] = []
    var hosts: [String] { lock.withLock { names } }
    func addresses(for host: String) async throws -> [String] {
        lock.withLock { names.append(host) }
        return host == "blocked.example" ? ["127.0.0.1"] : ["8.8.8.8"]
    }
}
