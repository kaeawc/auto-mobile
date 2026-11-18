@testable import AutoMobilePrototypeAgentCore
import XCTest
#if canImport(FoundationNetworking)
    import FoundationNetworking
#endif

/// What the stubbed network does for one request.
enum StubReply: @unchecked Sendable {
    case respond(status: Int, headers: [String: String], chunks: [Data])
    case redirect(status: Int, url: URL)
    case fail(code: Int)
    case hang
}

/// A `URLProtocol` that answers from a per-test registry, so the real `PrototypeURLSessionClient`
/// (its session, delegate, size cap, deadline and error mapping) runs with no network.
final class StubProtocol: URLProtocol {
    nonisolated(unsafe) static var handler: (@Sendable (URLRequest) -> StubReply)?
    nonisolated(unsafe) static var seen: [URLRequest] = []
    nonisolated(unsafe) static var seenBodies: [Data] = []
    private static let lock = NSLock()

    static func reset(_ handler: @escaping @Sendable (URLRequest) -> StubReply) {
        lock.withLock {
            self.handler = handler
            seen = []
            seenBodies = []
        }
    }

    static var requests: [URLRequest] { lock.withLock { seen } }
    static var bodies: [Data] { lock.withLock { seenBodies } }

    override class func canInit(with _: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let request = self.request
        var body = request.httpBody ?? Data()
        if let stream = request.httpBodyStream {
            stream.open()
            var buffer = [UInt8](repeating: 0, count: 1024)
            while stream.hasBytesAvailable {
                let bytesRead = stream.read(&buffer, maxLength: buffer.count)
                if bytesRead <= 0 { break }
                body.append(buffer, count: bytesRead)
            }
            stream.close()
        }
        let reply = Self.lock.withLock { () -> StubReply? in
            Self.seen.append(request)
            Self.seenBodies.append(body)
            return Self.handler?(request)
        }
        switch reply {
        case let .respond(status, headers, chunks)?:
            guard let url = request.url,
                  let response = HTTPURLResponse(
                      url: url,
                      statusCode: status,
                      httpVersion: "HTTP/1.1",
                      headerFields: headers
                  )
            else {
                client?.urlProtocol(self, didFailWithError: URLError(.badURL))
                return
            }
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            for chunk in chunks {
                client?.urlProtocol(self, didLoad: chunk)
            }
            client?.urlProtocolDidFinishLoading(self)
        case let .redirect(status, url)?:
            guard let source = request.url,
                  let response = HTTPURLResponse(
                      url: source,
                      statusCode: status,
                      httpVersion: "HTTP/1.1",
                      headerFields: [:]
                  )
            else { return }
            client?.urlProtocol(self, wasRedirectedTo: URLRequest(url: url), redirectResponse: response)
        case let .fail(code)?:
            client?.urlProtocol(self, didFailWithError: NSError(domain: NSURLErrorDomain, code: code))
        case .hang?, nil:
            break
        }
    }

    override func stopLoading() {}
}

final class PrototypeURLSessionClientTests: XCTestCase {
    private func client() -> PrototypeURLSessionClient {
        PrototypeURLSessionClient(
            protocolClasses: [StubProtocol.self],
            resolver: FakeHostResolver(),
            metrics: FakeConnectionMetrics.allowed
        )
    }

    private func call(
        _ url: String = "http://public.example:8080/feed?q=hello+world",
        method: PrototypeRequestMethod = .get,
        headers: [String: String] = [:],
        body: Data? = nil,
        timeoutMs: Int = 5000,
        maxBytes: Int = PrototypeLimits.maxResponseBytes
    )
        -> PrototypeHttpRequest
    {
        PrototypeHttpRequest(job: PrototypeRequestJob(
            requestId: "r-1", prototypeId: "p", via: .device, method: method, url: url, headers: headers,
            body: body.map { .string(String(decoding: $0, as: UTF8.self)) }, timeoutMs: timeoutMs
        ), maxResponseBytes: maxBytes)
    }

    private func failure(_ block: () async throws -> PrototypeHttpResponse) async -> PrototypeHttpFailure? {
        do {
            _ = try await block()
            return nil
        } catch let failure as PrototypeHttpFailure {
            return failure
        } catch {
            XCTFail("unexpected \(error)")
            return nil
        }
    }

    // MARK: Request

    func testADynamicUrlHeadersAndBodyReachTheSession() async throws {
        StubProtocol.reset { _ in .respond(status: 200, headers: [:], chunks: []) }
        let request = call(
            "http://public.example:8080/items/7?q=a+b&page=2", method: .post,
            headers: ["Accept": "application/json", "X-Token": "abc"], body: Data("payload".utf8)
        )
        _ = try await client().perform(request)
        let seen = try XCTUnwrap(StubProtocol.requests.first)
        XCTAssertEqual(seen.url?.absoluteString, "http://public.example:8080/items/7?q=a+b&page=2")
        XCTAssertEqual(seen.httpMethod, "POST")
        XCTAssertEqual(seen.value(forHTTPHeaderField: "Accept"), "application/json")
        XCTAssertEqual(seen.value(forHTTPHeaderField: "X-Token"), "abc")
        XCTAssertEqual(try String(decoding: XCTUnwrap(StubProtocol.bodies.first), as: UTF8.self), "payload")
        XCTAssertEqual(seen.cachePolicy, .reloadIgnoringLocalCacheData)
        XCTAssertEqual(seen.timeoutInterval, 5)
        XCTAssertFalse(seen.httpShouldHandleCookies)
    }

    func testAStringBodyDefaultsToTextPlainUnlessTheAuthorSetAContentType() async throws {
        StubProtocol.reset { _ in .respond(status: 200, headers: [:], chunks: []) }
        _ = try await client().perform(call(method: .post, body: Data("x".utf8)))
        _ = try await client().perform(call(
            method: .post, headers: ["content-type": "application/xml"], body: Data("x".utf8)
        ))
        let seen = StubProtocol.requests
        XCTAssertEqual(seen[0].value(forHTTPHeaderField: "Content-Type"), "text/plain; charset=utf-8")
        XCTAssertEqual(seen[1].value(forHTTPHeaderField: "Content-Type"), "application/xml")
    }

    func testAJsonBodyDefaultsToApplicationJson() {
        let job = PrototypeRequestJob(
            requestId: "r", prototypeId: "p", via: .device, method: .post, url: "http://public.example/",
            headers: [:], body: .object(["a": .number(1)]), timeoutMs: 1000
        )
        XCTAssertEqual(PrototypeHttpRequest(job: job).headers["Content-Type"], "application/json")
    }

    func testAnInvalidHeaderIsInvalidRequestAndNothingIsSent() async {
        StubProtocol.reset { _ in .respond(status: 200, headers: [:], chunks: []) }
        for headers in [["X-A": "a\r\nX-Evil: 1"], ["X-A": "a\nb"], ["X-A": "a\0b"], ["bad name": "v"], ["": "v"]] {
            let failed = await failure { try await client().perform(call(headers: headers)) }
            XCTAssertEqual(failed?.error.code, .invalidRequest, "\(headers)")
        }
        XCTAssertTrue(StubProtocol.requests.isEmpty)
        let twice = PrototypeHttpHeaderCheck.problem(in: ["X-Test": "1", "x-test": "2"])
        XCTAssertEqual(twice?.code, .invalidRequest)
        XCTAssertNil(PrototypeHttpHeaderCheck.problem(in: ["X-Token_1": "tab\there", "Accept": "a, b"]))
    }

    func testAGetSendsNoBody() async throws {
        StubProtocol.reset { _ in .respond(status: 200, headers: [:], chunks: []) }
        _ = try await client().perform(call())
        XCTAssertEqual(StubProtocol.bodies.first, Data())
    }

    func testTheUrlRequestRefusesAnUnparseableUrl() {
        XCTAssertNotNil(PrototypeURLSessionClient.urlRequest(for: call()))
        XCTAssertNil(PrototypeURLSessionClient.urlRequest(for: call("http://\u{0}")))
    }

    // MARK: Response

    func testAResponseCarriesStatusLowercasedHeadersBodyAndDuration() async throws {
        StubProtocol.reset { _ in
            .respond(
                status: 201,
                headers: ["Content-Type": "application/json", "X-Custom": "V"],
                chunks: [Data(#"{"a":"#.utf8), Data("1}".utf8)]
            )
        }
        let response = try await client().perform(call())
        XCTAssertEqual(response.status, 201)
        XCTAssertEqual(response.headers["content-type"], "application/json")
        XCTAssertEqual(response.headers["x-custom"], "V")
        XCTAssertEqual(response.body, Data(#"{"a":1}"#.utf8))
        XCTAssertGreaterThanOrEqual(response.durationMs, 0)
        XCTAssertEqual(
            response.requestResponse(for: .get),
            .received(
                status: 201,
                headers: response.headers,
                body: .object(["a": .number(1)]),
                durationMs: response.durationMs
            )
        )
    }

    func testANon2xxStatusIsAResponseNotAFailure() async throws {
        StubProtocol.reset { _ in .respond(status: 404, headers: [:], chunks: [Data("missing".utf8)]) }
        let response = try await client().perform(call())
        XCTAssertEqual(response.status, 404)
        XCTAssertEqual(response.body, Data())
    }

    func testANon2xxBodyOverTheCapIsAnHttpErrorNotTooLarge() async throws {
        StubProtocol.reset { _ in
            .respond(
                status: 500, headers: ["Content-Length": "100", "X-Id": "9"],
                chunks: [Data(count: 60), Data(count: 40)]
            )
        }
        let response = try await client().perform(call(maxBytes: 10))
        XCTAssertEqual(response.status, 500)
        XCTAssertEqual(response.headers["x-id"], "9")
        XCTAssertEqual(response.body, Data())
        let meta = PrototypeRequestMeta(response.requestResponse(for: .get))
        XCTAssertEqual(meta.error, PrototypeRequestError(.httpError, "HTTP 500"))
        XCTAssertEqual(meta.status, 500)
    }

    func testALiteralNullBodyIsAnInvalidResponseButAnEmptyBodyIsNot() async throws {
        StubProtocol.reset { _ in .respond(status: 200, headers: [:], chunks: [Data("null".utf8)]) }
        let failed = await failure { try await client().perform(call()) }
        XCTAssertEqual(failed?.error.code, .invalidResponse)
        StubProtocol.reset { _ in .respond(status: 200, headers: [:], chunks: []) }
        let empty = try await client().perform(call())
        XCTAssertEqual(empty.body, Data())
    }

    // MARK: Size cap

    func testABodyOverTheCapFailsAsTooLargeAsItArrives() async {
        StubProtocol.reset { _ in
            .respond(status: 200, headers: [:], chunks: [Data(count: 6), Data(count: 6), Data(count: 6)])
        }
        let failed = await failure { try await client().perform(call(maxBytes: 10)) }
        XCTAssertEqual(failed?.error, PrototypeRequestError(.tooLarge, "Response body exceeds 10 bytes."))
    }

    func testABodyExactlyAtTheCapIsAccepted() async throws {
        StubProtocol.reset { _ in .respond(status: 200, headers: [:], chunks: [Data(count: 5), Data(count: 5)]) }
        let response = try await client().perform(call(maxBytes: 10))
        XCTAssertEqual(response.body.count, 10)
    }

    func testADeclaredLengthOverTheCapFailsBeforeReading() async {
        StubProtocol.reset { _ in
            .respond(status: 200, headers: ["Content-Length": "100"], chunks: [Data(count: 4)])
        }
        let failed = await failure { try await client().perform(call(maxBytes: 10)) }
        XCTAssertEqual(failed?.error.code, .tooLarge)
    }

    // MARK: Deadline, cancellation and errors

    func testASilentServerEndsAtTheTotalDeadlineWithTimeout() async {
        StubProtocol.reset { _ in .hang }
        let failed = await failure { try await client().perform(call(timeoutMs: 30)) }
        XCTAssertEqual(failed?.error, PrototypeRequestError(.timeout, "Request timed out after 30ms."))
        XCTAssertGreaterThanOrEqual(failed?.durationMs ?? -1, 0)
    }

    func testCancellingTheCallingTaskEndsTheCallAsCancelled() async {
        StubProtocol.reset { _ in .hang }
        let client = client()
        let request = call(timeoutMs: 20000)
        let task = Task { try await client.perform(request) }
        for _ in 0 ..< 500 where StubProtocol.requests.isEmpty {
            await Task.yield()
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
        task.cancel()
        let failed = await failure { try await task.value }
        XCTAssertEqual(failed?.error, PrototypeRequestError(.cancelled, "Request was cancelled."))
    }

    func testANetworkErrorIsMappedToItsTypedCode() async {
        StubProtocol.reset { _ in .fail(code: URLError.Code.cannotConnectToHost.rawValue) }
        let failed = await failure { try await client().perform(call()) }
        XCTAssertEqual(
            failed?.error,
            PrototypeRequestError(
                .connectionRefused,
                "Connection refused: http://public.example:8080/feed?q=hello+world"
            )
        )
    }

    func testAnAppTransportSecurityBlockTellsTheAuthorToUseTheHost() async {
        StubProtocol.reset { _ in .fail(code: PrototypeURLErrorMapping.appTransportSecurityCode) }
        let failed = await failure { try await client().perform(call("http://example.com/x")) }
        XCTAssertEqual(failed?.error.code, .network)
        XCTAssertTrue(failed?.error.message.contains("via \"host\"") == true)
        XCTAssertTrue(failed?.error.message.contains("App Transport Security") == true)
    }

    func testAnInvalidUrlFailsBeforeTheSession() async {
        StubProtocol.reset { _ in .respond(status: 200, headers: [:], chunks: []) }
        let failed = await failure { try await client().perform(call("http://\u{0}")) }
        XCTAssertEqual(failed?.error.code, .invalidURL)
        XCTAssertTrue(StubProtocol.requests.isEmpty)
    }

    func testErrorMappingTable() {
        func map(
            _ error: Error,
            timedOut: Bool = false,
            tooLarge: Bool = false,
            cancelled: Bool = false
        )
            -> PrototypeRequestErrorCode
        {
            PrototypeURLErrorMapping.map(
                error, url: "http://h/", timeoutMs: 10, timedOut: timedOut, tooLarge: tooLarge,
                cancelledByCaller: cancelled, maxBytes: 5
            ).code
        }
        XCTAssertEqual(map(URLError(.timedOut)), .timeout)
        XCTAssertEqual(map(URLError(.cancelled)), .cancelled)
        XCTAssertEqual(map(URLError(.cannotConnectToHost)), .connectionRefused)
        XCTAssertEqual(map(URLError(.badURL)), .invalidURL)
        XCTAssertEqual(map(URLError(.unsupportedURL)), .invalidURL)
        XCTAssertEqual(map(URLError(.cannotFindHost)), .network)
        XCTAssertEqual(map(URLError(.networkConnectionLost)), .network)
        XCTAssertEqual(map(NSError(domain: "x", code: 1)), .network)
        // Our own deadline or size cap cancels the task, so its flag wins over the resulting `cancelled`.
        XCTAssertEqual(map(URLError(.cancelled), timedOut: true), .timeout)
        XCTAssertEqual(map(URLError(.cancelled), tooLarge: true), .tooLarge)
        XCTAssertEqual(map(URLError(.cancelled), cancelled: true), .cancelled)
        XCTAssertEqual(map(URLError(.timedOut), cancelled: true), .cancelled)
    }
}

extension PrototypeURLSessionClientTests {
    func testDefaultPolicyBlocksNamesAndLiteralsBeforeDNSOrTransport() async {
        StubProtocol.reset { _ in .respond(status: 200, headers: [:], chunks: []) }
        let resolver = FakeHostResolver()
        let client = PrototypeURLSessionClient(
            protocolClasses: [StubProtocol.self],
            resolver: resolver,
            metrics: FakeConnectionMetrics.allowed
        )
        for host in [
            "127.0.0.1",
            "2130706433",
            "0x7f.1",
            "0177.0.0.1",
            "[::1]",
            "[::ffff:7f00:1]",
            "[64:ff9b::7f00:1]",
            "[2002:7f00:1::]",
            "[fe80::1]",
            "localhost",
            "LOCALHOST.",
            "foo.localhost",
        ] {
            let failed = await failure { try await client.perform(call("http://\(host)/")) }
            XCTAssertEqual(failed?.error.code, .blockedDestination, host)
        }
        XCTAssertTrue(resolver.requestedHosts.isEmpty)
        XCTAssertTrue(StubProtocol.requests.isEmpty)
    }

    func testMixedDNSAnswersAndEmptyAnswersAreRefused() async {
        StubProtocol.reset { _ in .respond(status: 200, headers: [:], chunks: []) }
        for answers in [["8.8.8.8", "127.0.0.1"], []] {
            let client = PrototypeURLSessionClient(
                protocolClasses: [StubProtocol.self],
                resolver: FakeHostResolver(answers), metrics: FakeConnectionMetrics.allowed
            )
            let failed = await failure { try await client.perform(call()) }
            XCTAssertEqual(failed?.error.code, .blockedDestination)
        }
        XCTAssertTrue(StubProtocol.requests.isEmpty)
    }

    func testForbiddenHeadersAreRejectedBeforeDNSAndTransport() async {
        StubProtocol.reset { _ in .respond(status: 200, headers: [:], chunks: []) }
        let resolver = FakeHostResolver()
        let client = PrototypeURLSessionClient(
            protocolClasses: [StubProtocol.self],
            resolver: resolver,
            metrics: FakeConnectionMetrics.allowed
        )
        for name in [
            "hOsT",
            "cOnNeCtIoN",
            "uPgRaDe",
            "tRaNsFeR-EnCoDiNg",
            "cOnTeNt-LeNgTh",
            "tE",
            "tRaIlEr",
            "kEeP-AlIvE",
            "cOoKiE",
            "eXpEcT",
            "oRiGiN",
            "pRoXy-AuThOrIzAtIoN",
            "PrOxY-Custom",
        ] {
            let failed = await failure { try await client.perform(call(headers: [name: "x"])) }
            XCTAssertEqual(failed?.error.code, .invalidRequest, name)
        }
        XCTAssertTrue(resolver.requestedHosts.isEmpty)
        XCTAssertTrue(StubProtocol.requests.isEmpty)
    }

    func testRedirectsToBlockedDestinationsDowngradesAndSixthHopFail() async throws {
        for target in ["http://127.0.0.1/", "http://public.example/"] {
            let url = try XCTUnwrap(URL(string: target))
            StubProtocol.reset { _ in .redirect(status: 302, url: url) }
            let failed = await failure { try await client().perform(call("https://public.example/")) }
            XCTAssertEqual(failed?.error.code, .blockedDestination, target)
            XCTAssertEqual(StubProtocol.requests.count, 1)
        }
        let url = try XCTUnwrap(URL(string: "https://public.example/loop"))
        StubProtocol.reset { _ in .redirect(status: 302, url: url) }
        let failed = await failure { try await client().perform(call("https://public.example/")) }
        XCTAssertEqual(failed?.error.code, .blockedDestination)
        XCTAssertEqual(StubProtocol.requests.count, 6)
    }

    func testPublicRedirectsApplyMethodBodyAndOriginRules() async throws {
        let target = try XCTUnwrap(URL(string: "https://other.example/done"))
        for status in [301, 302, 303, 307, 308] {
            StubProtocol.reset { request in
                request.url?.path == "/done"
                    ? .respond(status: 200, headers: [:], chunks: [Data("ok".utf8)])
                    : .redirect(status: status, url: target)
            }
            let resolver = FakeHostResolver()
            let client = PrototypeURLSessionClient(
                protocolClasses: [StubProtocol.self],
                resolver: resolver,
                metrics: FakeConnectionMetrics.allowed
            )
            let result = try await client.perform(call(
                "https://public.example/start", method: .post,
                headers: ["Authorization": "Bearer value", "X-Token": "kept"], body: Data("payload".utf8)
            ))
            XCTAssertEqual(result.body, Data("ok".utf8))
            let next = try XCTUnwrap(StubProtocol.requests.last)
            XCTAssertEqual(next.httpMethod, status < 307 ? "GET" : "POST", "\(status)")
            XCTAssertEqual(StubProtocol.bodies.last, status < 307 ? Data() : Data("payload".utf8))
            XCTAssertNil(next.value(forHTTPHeaderField: "Authorization"))
            XCTAssertEqual(next.value(forHTTPHeaderField: "X-Token"), "kept")
            XCTAssertEqual(resolver.requestedHosts, ["public.example", "other.example"])
        }
    }
}

extension PrototypeURLSessionClientTests {
    func testRedirectMethodRewriteFollowsFetchAndStripsEntityHeaders() async throws {
        let egress = PrototypeRequestEgressCheck(policy: PrototypeEgressPolicy(), resolver: FakeHostResolver())
        let cases: [(String, Int, String)] = [
            ("POST", 301, "GET"), ("POST", 302, "GET"), ("POST", 303, "GET"),
            ("PUT", 301, "PUT"), ("PATCH", 302, "PATCH"), ("DELETE", 302, "DELETE"),
            ("PUT", 303, "GET"), ("DELETE", 303, "GET"), ("HEAD", 303, "HEAD"),
            ("POST", 307, "POST"), ("PUT", 308, "PUT"),
        ]
        for (method, status, expected) in cases {
            let source = try XCTUnwrap(PrototypeURLSessionClient.urlRequest(for: call(
                "https://public.example/start", method: PrototypeRequestMethod(rawValue: method) ?? .post,
                headers: ["Content-Type": "application/json", "Content-Language": "en", "X-Token": "kept"],
                body: Data("payload".utf8)
            )))
            let state = PrototypeURLSessionCall(maxBytes: 100, timeoutMs: 1000, request: source)
            let next = try await state.redirect(
                to: XCTUnwrap(URL(string: "https://public.example/next")),
                status: status,
                egress: egress
            )
            XCTAssertEqual(next.httpMethod, expected, "\(method) \(status)")
            XCTAssertEqual(next.value(forHTTPHeaderField: "X-Token"), "kept")
            let rewritten = expected != method
            XCTAssertEqual(
                next.value(forHTTPHeaderField: "Content-Type"),
                rewritten ? nil : "application/json",
                "\(method) \(status)"
            )
            XCTAssertEqual(
                next.value(forHTTPHeaderField: "Content-Language"),
                rewritten ? nil : "en",
                "\(method) \(status)"
            )
        }
    }

    func testAuthorizationOriginComparisonIncludesSchemeAndPort() async throws {
        let egress = PrototypeRequestEgressCheck(policy: PrototypeEgressPolicy(), resolver: FakeHostResolver())
        for (target, keepsAuthorization) in [
            ("http://public.example/next", true),
            ("http://public.example:80/next", true),
            ("https://public.example/next", false),
            ("http://public.example:8080/next", false),
            ("http://other.example/next", false),
        ] {
            let source = try XCTUnwrap(PrototypeURLSessionClient.urlRequest(for: call(
                "http://public.example/start", headers: ["Authorization": "value"]
            )))
            let state = PrototypeURLSessionCall(maxBytes: 100, timeoutMs: 1000, request: source)
            let next = try await state.redirect(to: XCTUnwrap(URL(string: target)), status: 302, egress: egress)
            XCTAssertEqual(next.value(forHTTPHeaderField: "Authorization"), keepsAuthorization ? "value" : nil, target)
        }
    }

    func testFiveRedirectsSucceedAndHeadMethodIsPreserved() async throws {
        let base = try XCTUnwrap(URL(string: "https://public.example/"))
        StubProtocol.reset { request in
            let hop = Int(request.url?.lastPathComponent ?? "") ?? 0
            return hop == 5 ? .respond(status: 200, headers: [:], chunks: [])
                : .redirect(status: 303, url: base.appendingPathComponent(String(hop + 1)))
        }
        let response = try await client().perform(call(base.absoluteString, method: .head))
        XCTAssertEqual(response.status, 200)
        XCTAssertEqual(StubProtocol.requests.count, 6)
        XCTAssertTrue(StubProtocol.requests.allSatisfy { $0.httpMethod == "HEAD" })
    }

    func testRedirectRerunsDNSAndRejectsMixedAnswers() async throws {
        let target = try XCTUnwrap(URL(string: "https://public.example/done"))
        StubProtocol.reset { _ in .redirect(status: 307, url: target) }
        // The first hop is a public literal. The redirect is a name with one blocked answer.
        let resolver = FakeHostResolver(["8.8.8.8", "127.0.0.1"])
        let client = PrototypeURLSessionClient(
            protocolClasses: [StubProtocol.self],
            resolver: resolver,
            metrics: FakeConnectionMetrics.allowed
        )
        let failed = await failure { try await client.perform(call("https://8.8.8.8/start")) }
        XCTAssertEqual(failed?.error.code, .blockedDestination)
        XCTAssertEqual(resolver.requestedHosts, ["public.example"])
        XCTAssertEqual(StubProtocol.requests.count, 1)
    }

    func testRedirectRefusesUnsupportedScheme() async throws {
        let egress = PrototypeRequestEgressCheck(policy: PrototypeEgressPolicy(), resolver: FakeHostResolver())
        let source = try XCTUnwrap(PrototypeURLSessionClient.urlRequest(for: call()))
        let state = PrototypeURLSessionCall(maxBytes: 100, timeoutMs: 1000, request: source)
        do {
            _ = try await state.redirect(
                to: XCTUnwrap(URL(string: "ftp://public.example/")), status: 302, egress: egress
            )
            XCTFail("Accepted an unsupported scheme")
        } catch {
            XCTAssertEqual((error as? PrototypeRequestError)?.code, .blockedDestination)
        }
    }
}

extension PrototypeURLSessionClientTests {
    private func uploadCall() -> PrototypeHttpRequest {
        PrototypeHttpRequest(job: PrototypeRequestJob(
            requestId: "upload", prototypeId: "p", via: .device, method: .post,
            url: "https://public.example/start", headers: ["content-type": "wrong"], body: nil, timeoutMs: 5000,
            uploadBody: .init(data: Data("original bytes".utf8), contentType: "image/png", fileBytes: 14)
        ))
    }

    func testUploadTaskSendsOriginalBytesAndOverridesContentType() async throws {
        StubProtocol.reset { _ in .respond(status: 200, headers: [:], chunks: [Data("ok".utf8)]) }
        let response = try await client().perform(uploadCall())
        XCTAssertEqual(response.status, 200)
        XCTAssertEqual(StubProtocol.bodies, [Data("original bytes".utf8)])
        XCTAssertEqual(StubProtocol.requests.first?.value(forHTTPHeaderField: "Content-Type"), "image/png")
    }

    func testUploadRedirectsResendOn307And308AndDropBodyOn301302303() async throws {
        let target = try XCTUnwrap(URL(string: "https://public.example/target"))
        for status in [301, 302, 303, 307, 308] {
            StubProtocol.reset { request in
                if request.url?.path == "/start" { return .redirect(status: status, url: target) }
                return .respond(status: 200, headers: [:], chunks: [])
            }
            _ = try await client().perform(uploadCall())
            XCTAssertEqual(StubProtocol.requests.count, 2, "\(status)")
            let retained = status == 307 || status == 308
            XCTAssertEqual(StubProtocol.requests.last?.httpMethod, retained ? "POST" : "GET", "\(status)")
            XCTAssertEqual(StubProtocol.bodies.last, retained ? Data("original bytes".utf8) : Data(), "\(status)")
            XCTAssertEqual(
                StubProtocol.requests.last?.value(forHTTPHeaderField: "Content-Type"), retained ? "image/png" : nil
            )
        }
    }

    func testUploadRedirectClearsRetainedBodyStreamAfterGetDowngrade() async throws {
        let egress = PrototypeRequestEgressCheck(policy: .init(), resolver: FakeHostResolver())
        for status in [301, 302, 303, 307, 308] {
            let request = uploadCall()
            let source = try XCTUnwrap(PrototypeURLSessionClient.urlRequest(for: request))
            XCTAssertNil(source.httpBody) // Bytes belong to the upload task, not URLRequest.
            let state = PrototypeURLSessionCall(
                maxBytes: 100, timeoutMs: 1000, request: source, uploadBody: request.uploadBody?.data
            )
            let next = try await state.redirect(
                to: XCTUnwrap(URL(string: "https://other.example/target")), status: status, egress: egress
            )
            if status == 307 || status == 308 {
                XCTAssertEqual(next.httpMethod, "POST")
                XCTAssertNotNil(next.httpBodyStream)
                XCTAssertNotNil(state.newBodyStream())
            } else {
                XCTAssertEqual(next.httpMethod, "GET")
                XCTAssertNil(next.httpBody)
                XCTAssertNil(next.httpBodyStream)
                XCTAssertNil(state.newBodyStream())
            }
        }
    }

    func testPreservingRedirectAfterGetDowngradeDoesNotRestoreUploadBody() async throws {
        let target = try XCTUnwrap(URL(string: "https://public.example/target"))
        let finalURL = try XCTUnwrap(URL(string: "https://public.example/final"))
        for downgrade in [301, 302, 303] {
            for preserving in [307, 308] {
                StubProtocol.reset { request in
                    switch request.url?.path {
                    case "/start": .redirect(status: downgrade, url: target)
                    case "/target": .redirect(status: preserving, url: finalURL)
                    default: .respond(status: 200, headers: [:], chunks: [])
                    }
                }
                _ = try await client().perform(uploadCall())
                XCTAssertEqual(StubProtocol.requests.count, 3, "\(downgrade) then \(preserving)")
                XCTAssertEqual(StubProtocol.bodies, [Data("original bytes".utf8), Data(), Data()])
                for request in StubProtocol.requests.dropFirst() {
                    XCTAssertEqual(request.httpMethod, "GET")
                    XCTAssertNil(request.httpBody)
                    XCTAssertNil(request.httpBodyStream)
                    XCTAssertNil(request.value(forHTTPHeaderField: "Content-Type"))
                }
            }
        }
    }

    func testOrdinaryDataTaskBodyCanStillBeReplayedByTheDelegate() throws {
        let source = try XCTUnwrap(PrototypeURLSessionClient.urlRequest(for: call(
            "https://public.example/", method: .post, body: Data("json body".utf8)
        )))
        let state = PrototypeURLSessionCall(maxBytes: 100, timeoutMs: 1000, request: source)
        let stream = try XCTUnwrap(state.newBodyStream())
        stream.open()
        defer { stream.close() }
        var replay = Data()
        var buffer = [UInt8](repeating: 0, count: 4)
        while true {
            let count = stream.read(&buffer, maxLength: buffer.count)
            XCTAssertGreaterThanOrEqual(count, 0)
            if count <= 0 { break }
            replay.append(buffer, count: count)
        }
        XCTAssertEqual(replay, Data("json body".utf8))
    }

    func testUploadTotalDeadlineEndsAsTypedTimeoutWithInjectedScheduler() async throws {
        let arrived = expectation(description: "upload reached stub")
        let deadline = FakePinnedDeadline()
        StubProtocol.reset { _ in arrived.fulfill(); return .hang }
        let client = PrototypeURLSessionClient(
            protocolClasses: [StubProtocol.self], resolver: FakeHostResolver(),
            metrics: FakeConnectionMetrics.allowed, deadlines: deadline
        )
        let request = uploadCall()
        let task = Task { try await client.perform(request) }
        guard await XCTWaiter.fulfillment(of: [arrived], timeout: 1) == .completed else {
            XCTFail("Upload did not reach the stub")
            task.cancel()
            return
        }
        deadline.fire()
        let failed = await failure { try await task.value }
        XCTAssertEqual(failed?.error.code, .timeout)
        XCTAssertEqual(deadline.scheduleCount, 1)
        XCTAssertEqual(deadline.scheduledDelays, [request.timeoutMs])
        XCTAssertEqual(deadline.cancelCount, 1)
    }

    func testCancellingUploadEndsAsTypedCancelledWithoutSleeping() async {
        let arrived = expectation(description: "upload reached stub")
        StubProtocol.reset { _ in arrived.fulfill(); return .hang }
        let deadline = FakePinnedDeadline()
        let client = PrototypeURLSessionClient(
            protocolClasses: [StubProtocol.self], resolver: FakeHostResolver(),
            metrics: FakeConnectionMetrics.allowed, deadlines: deadline
        )
        let request = uploadCall()
        let task = Task { try await client.perform(request) }
        guard await XCTWaiter.fulfillment(of: [arrived], timeout: 1) == .completed else {
            XCTFail("Upload did not reach the stub")
            task.cancel()
            return
        }
        task.cancel()
        let failed = await failure { try await task.value }
        XCTAssertEqual(failed?.error.code, .cancelled)
        XCTAssertEqual(deadline.scheduledDelays, [request.timeoutMs])
        XCTAssertEqual(deadline.cancelCount, 1)
    }
}

extension PrototypeURLSessionClientTests {
    func testUploadATSFailureRequiresHTTPSOnDevice() async {
        StubProtocol.reset { _ in .fail(code: PrototypeURLErrorMapping.appTransportSecurityCode) }
        let failed = await failure { try await client().perform(uploadCall()) }
        XCTAssertEqual(failed?.error.code, .network)
        XCTAssertTrue(failed?.error.message.contains("HTTPS") == true)
        XCTAssertTrue(failed?.error.message.contains("via \"device\"") == true)
        XCTAssertFalse(failed?.error.message.contains("host") == true)
    }

    func testDeadlineHandleIsCancelledIfTheCallFinishesDuringSchedulerInstallation() async throws {
        let request = uploadCall()
        let source = try XCTUnwrap(PrototypeURLSessionClient.urlRequest(for: request))
        let call = PrototypeURLSessionCall(
            maxBytes: 100, timeoutMs: request.timeoutMs, request: source, uploadBody: request.uploadBody?.data
        )
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        let task = session.dataTask(with: source)
        let deadline = FakePinnedDeadline()
        deadline.onSchedule = { call.finish(error: URLError(.cancelled), measuredMs: 0) }
        let failed = await failure {
            try await withCheckedThrowingContinuation { continuation in
                call.install(continuation)
                call.armDeadline(cancelling: PrototypeURLSessionTaskHandle(task), scheduler: deadline)
            }
        }
        XCTAssertEqual(failed?.error.code, .cancelled)
        XCTAssertEqual(deadline.scheduledDelays, [request.timeoutMs])
        XCTAssertEqual(deadline.cancelCount, 1)
        deadline.fire()
        XCTAssertFalse(call.canProceed)
    }
}
