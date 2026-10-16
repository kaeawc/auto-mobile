@testable import AutoMobilePrototypeAgentCore
import XCTest
#if canImport(FoundationNetworking)
    import FoundationNetworking
#endif

/// What the stubbed network does for one request.
enum StubReply: @unchecked Sendable {
    case respond(status: Int, headers: [String: String], chunks: [Data])
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
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                body.append(buffer, count: count)
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
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: status,
                httpVersion: "HTTP/1.1",
                headerFields: headers
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            for chunk in chunks {
                client?.urlProtocol(self, didLoad: chunk)
            }
            client?.urlProtocolDidFinishLoading(self)
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
        PrototypeURLSessionClient(protocolClasses: [StubProtocol.self])
    }

    private func call(
        _ url: String = "http://localhost:8080/feed?q=hello+world",
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
            "http://localhost:8080/items/7?q=a+b&page=2", method: .post,
            headers: ["Accept": "application/json", "X-Token": "abc"], body: Data("payload".utf8)
        )
        _ = try await client().perform(request)
        let seen = try XCTUnwrap(StubProtocol.requests.first)
        XCTAssertEqual(seen.url?.absoluteString, "http://localhost:8080/items/7?q=a+b&page=2")
        XCTAssertEqual(seen.httpMethod, "POST")
        XCTAssertEqual(seen.value(forHTTPHeaderField: "Accept"), "application/json")
        XCTAssertEqual(seen.value(forHTTPHeaderField: "X-Token"), "abc")
        XCTAssertEqual(try String(decoding: XCTUnwrap(StubProtocol.bodies.first), as: UTF8.self), "payload")
        XCTAssertEqual(seen.cachePolicy, .reloadIgnoringLocalCacheData)
        XCTAssertEqual(seen.timeoutInterval, 5)
        XCTAssertFalse(seen.httpShouldHandleCookies)
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
            PrototypeRequestError(.connectionRefused, "Connection refused: http://localhost:8080/feed?q=hello+world")
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
