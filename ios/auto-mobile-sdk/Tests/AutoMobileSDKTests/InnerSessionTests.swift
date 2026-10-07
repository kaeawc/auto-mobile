// swiftlint:disable force_unwrapping
// Force-unwrap is idiomatic in test fixtures (fail fast on bad setup); disabled file-wide.

@testable import AutoMobileSDK
import Network
import os
import XCTest

private func text(_ data: Data) -> String { String(data: data, encoding: .utf8) ?? "" }

// MARK: - Loopback HTTP/1.1 server (127.0.0.1 only, no external network)

private final class LoopbackHTTPServer: @unchecked Sendable {
    struct Request {
        let method: String
        let path: String
        let headers: [String: String]
    }

    struct Response {
        var status = 200
        var headers: [String: String] = [:]
        var body = ""
    }

    private let queue = DispatchQueue(label: "dev.jasonpearson.automobile.tests.loopback")
    private let lock = NSLock()
    private var listener: NWListener?
    private var _accepted = 0
    private var _requests: [Request] = []
    private let handler: @Sendable (Request) -> Response

    init(handler: @escaping @Sendable (Request) -> Response) {
        self.handler = handler
    }

    var acceptedConnections: Int { lock.lock(); defer { lock.unlock() }; return _accepted }
    var requests: [Request] { lock.lock(); defer { lock.unlock() }; return _requests }

    func start() throws -> URL {
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        let listener = try NWListener(using: params)
        let ready = DispatchSemaphore(value: 0)
        listener.stateUpdateHandler = { state in
            if case .ready = state { ready.signal() }
            if case .failed = state { ready.signal() }
        }
        listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
        listener.start(queue: queue)
        guard ready.wait(timeout: .now() + 5) == .success, let port = listener.port else {
            throw URLError(.cannotConnectToHost)
        }
        self.listener = listener
        return URL(string: "http://127.0.0.1:\(port.rawValue)")!
    }

    func stop() {
        listener?.cancel()
    }

    private func accept(_ connection: NWConnection) {
        lock.lock(); _accepted += 1; lock.unlock()
        connection.start(queue: queue)
        receive(on: connection, buffer: Data())
    }

    private func receive(on connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            var buffer = buffer
            if let data { buffer.append(data) }
            let terminator = Data("\r\n\r\n".utf8)
            while let range = buffer.range(of: terminator) {
                let head = text(Data(buffer[..<range.lowerBound]))
                buffer.removeSubrange(..<range.upperBound)
                self.respond(to: head, on: connection)
            }
            if error != nil || isComplete {
                connection.cancel()
            } else {
                self.receive(on: connection, buffer: buffer)
            }
        }
    }

    private func respond(to head: String, on connection: NWConnection) {
        let lines = head.components(separatedBy: "\r\n")
        let parts = lines[0].split(separator: " ")
        guard parts.count >= 2 else { return }
        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { continue }
            headers[line[..<colon].lowercased()] = line[line.index(after: colon)...]
                .trimmingCharacters(in: .whitespaces)
        }
        let request = Request(method: String(parts[0]), path: String(parts[1]), headers: headers)
        lock.lock(); _requests.append(request); lock.unlock()

        let response = handler(request)
        var out = "HTTP/1.1 \(response.status) X\r\nContent-Length: \(response.body.utf8.count)\r\n"
        out += "Connection: keep-alive\r\n"
        for (name, value) in response.headers {
            out += "\(name): \(value)\r\n"
        }
        out += "\r\n" + response.body
        connection.send(content: Data(out.utf8), completion: .contentProcessed { _ in })
    }
}

// MARK: - App-side task delegate (stands in for the app's redirect / challenge handling)

private final class AppTaskDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var _redirects: [(response: Int, newURL: String?)] = []
    private var _challengeMethods: [String] = []
    var challengeAnswer: (disposition: URLSession.AuthChallengeDisposition, credential: URLCredential?) =
        (.performDefaultHandling, nil)

    var redirects: [(response: Int, newURL: String?)] { lock.lock(); defer { lock.unlock() }; return _redirects }
    var challengeMethods: [String] { lock.lock(); defer { lock.unlock() }; return _challengeMethods }

    func urlSession(
        _: URLSession,
        task _: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        lock.lock(); _redirects.append((response.statusCode, request.url?.absoluteString)); lock.unlock()
        completionHandler(request)
    }

    func urlSession(
        _: URLSession,
        task _: URLSessionTask,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        lock.lock(); _challengeMethods.append(challenge.protectionSpace.authenticationMethod); lock.unlock()
        completionHandler(challengeAnswer.disposition, challengeAnswer.credential)
    }
}

/// Records the client callbacks and the forwarded challenge, without a real URL loading system.
private final class ForwardingRecordingClient: NSObject, URLProtocolClient, @unchecked Sendable {
    private let lock = NSLock()
    private var _calls: [String] = []
    private var _challenge: URLAuthenticationChallenge?

    var calls: [String] { lock.lock(); defer { lock.unlock() }; return _calls }
    var challenge: URLAuthenticationChallenge? { lock.lock(); defer { lock.unlock() }; return _challenge }

    private func record(_ name: String) { lock.lock(); _calls.append(name); lock.unlock() }

    func urlProtocol(_: URLProtocol, wasRedirectedTo _: URLRequest, redirectResponse _: URLResponse) {
        record("redirect")
    }

    func urlProtocol(_: URLProtocol, cachedResponseIsValid _: CachedURLResponse) { record("cached") }
    func urlProtocol(_: URLProtocol, didReceive _: URLResponse, cacheStoragePolicy _: URLCache.StoragePolicy) {
        record("didReceive")
    }

    func urlProtocol(_: URLProtocol, didLoad _: Data) { record("didLoad") }
    func urlProtocolDidFinishLoading(_: URLProtocol) { record("finish") }
    func urlProtocol(_: URLProtocol, didFailWithError _: Error) { record("didFail") }
    func urlProtocol(_: URLProtocol, didReceive challenge: URLAuthenticationChallenge) {
        lock.lock(); _challenge = challenge; lock.unlock()
        record("challenge")
    }

    func urlProtocol(_: URLProtocol, didCancel _: URLAuthenticationChallenge) { record("cancelChallenge") }
}

private final class ChallengeOutcome: @unchecked Sendable {
    private let lock = NSLock()
    private var _outcomes: [(URLSession.AuthChallengeDisposition, URLCredential?)] = []
    var outcomes: [(URLSession.AuthChallengeDisposition, URLCredential?)] {
        lock.lock(); defer { lock.unlock() }; return _outcomes
    }

    func complete(_ disposition: URLSession.AuthChallengeDisposition, _ credential: URLCredential?) {
        lock.lock(); _outcomes.append((disposition, credential)); lock.unlock()
    }
}

// MARK: - Tests

/// Issues #10138 (one long-lived inner session) and #10139 (challenges, declines).
/// The end-to-end cases drive the real URL loading system against an in-process loopback server;
/// nothing leaves the machine.
final class InnerSessionTests: XCTestCase {
    private var server: LoopbackHTTPServer?
    private var baseURL: URL!
    private var outerSession: URLSession!

    override func setUp() {
        super.setUp()
        // A fresh host per test isolates connection counts; production keeps one for the process.
        AutoMobileURLProtocol.innerSessionHost = InnerSessionHost()
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AutoMobileNetwork.shared.protocolClass()]
        outerSession = URLSession(configuration: config)
    }

    override func tearDown() {
        outerSession.invalidateAndCancel()
        server?.stop()
        if let storage = HTTPCookieStorage.shared.cookies(for: URL(string: "http://127.0.0.1")!) {
            storage.forEach { HTTPCookieStorage.shared.deleteCookie($0) }
        }
        AutoMobileURLProtocol.innerSessionHost = InnerSessionHost()
        AutoMobileNetwork.shared.reset()
        super.tearDown()
    }

    private func startServer(
        _ handler: @escaping @Sendable (LoopbackHTTPServer.Request) -> LoopbackHTTPServer
            .Response
    )
        throws
    {
        let server = LoopbackHTTPServer(handler: handler)
        baseURL = try server.start()
        self.server = server
    }

    private func get(_ path: String, delegate: AppTaskDelegate? = nil, configure: ((inout URLRequest) -> Void)? = nil)
        async throws -> (Data, HTTPURLResponse)
    {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.timeoutInterval = 8
        configure?(&request)
        let (data, response) = try await outerSession.data(for: request, delegate: delegate)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        return (data, http)
    }

    // MARK: #10138 cookies, connection reuse, shared storage

    func testCookieFromSetCookieIsSentOnNextRequestAndStoredInSharedStorage() async throws {
        try startServer { request in
            switch request.path {
            case "/login":
                return .init(headers: ["Set-Cookie": "session=abc123; Path=/"], body: "ok")
            default:
                let cookie = request.headers["cookie"] ?? ""
                return cookie.contains("session=abc123") ? .init(body: "me") : .init(status: 401, body: "no cookie")
            }
        }

        let (_, login) = try await get("login")
        let (body, meResponse) = try await get("me")

        XCTAssertEqual(login.statusCode, 200)
        XCTAssertEqual(meResponse.statusCode, 200, "the stored cookie must be sent on the next request")
        XCTAssertEqual(text(body), "me")
        let stored = HTTPCookieStorage.shared.cookies(for: baseURL) ?? []
        XCTAssertTrue(stored.contains { $0.name == "session" && $0.value == "abc123" })
    }

    func testRequestOptOutOfCookieHandlingIsHonoured() async throws {
        try startServer { request in
            request.path == "/login"
                ? .init(headers: ["Set-Cookie": "session=abc123; Path=/"], body: "ok")
                : .init(body: request.headers["cookie"] ?? "none")
        }

        _ = try await get("login")
        let (body, _) = try await get("me") { $0.httpShouldHandleCookies = false }

        XCTAssertEqual(text(body), "none")
    }

    func testSequentialRequestsReuseOneConnectionOnOneSession() async throws {
        try startServer { _ in .init(body: "ok") }
        let host = AutoMobileURLProtocol.innerSessionHost

        for index in 0 ..< 3 {
            let (_, response) = try await get("r\(index)")
            XCTAssertEqual(response.statusCode, 200)
        }

        XCTAssertEqual(server?.requests.count, 3)
        XCTAssertEqual(server?.acceptedConnections, 1, "one pooled connection, not one handshake per request")
        XCTAssertEqual(host.sessionsBuilt, 1)
        XCTAssertTrue(AutoMobileURLProtocol.innerSessionHost === host)
    }

    func testInnerSessionMirrorsSharedStorageAndExcludesOurProtocol() {
        let configuration = AutoMobileURLProtocol.innerSessionHost.session.configuration

        XCTAssertTrue(configuration.httpCookieStorage === HTTPCookieStorage.shared)
        XCTAssertTrue(configuration.urlCredentialStorage === URLCredentialStorage.shared)
        XCTAssertTrue(configuration.urlCache === URLCache.shared)
        XCTAssertTrue(configuration.httpShouldSetCookies)
        let classes = configuration.protocolClasses ?? []
        XCTAssertFalse(classes.contains { $0 == AutoMobileURLProtocol.self })
    }

    func testInFlightRoutesAreReleasedAfterCompletionAndNoSessionIsInvalidated() async throws {
        try startServer { _ in .init(body: "ok") }
        let host = AutoMobileURLProtocol.innerSessionHost

        _ = try await get("a")
        _ = try await get("b")

        XCTAssertEqual(host.inFlightTaskCount, 0)
        XCTAssertEqual(host.sessionsBuilt, 1)
        let (_, response) = try await get("c")
        XCTAssertEqual(response.statusCode, 200, "the session is still usable after earlier requests finished")
    }

    func testInjectedConfigurationBuildsExactlyOneSession() throws {
        let builds = OSAllocatedUnfairLock(initialState: 0)
        let host = InnerSessionHost(makeConfiguration: {
            builds.withLock { $0 += 1 }
            return InnerSessionHost.mirroredConfiguration()
        })

        let first = host.session
        let second = host.session

        XCTAssertTrue(first === second)
        XCTAssertEqual(builds.withLock { $0 }, 1)
    }

    // MARK: Redirects

    // The inner session follows redirects itself and the app's redirect delegate is not consulted.
    // Forwarding redirects to the app's delegate is deferred to #10139: handing the redirect to the
    // URL loading system raced the inner 302's completion and could trap `URLSession.data(for:)`.

    func testRedirectIsFollowedByTheInnerSessionAndTheFinalResponseIsCaptured() async throws {
        try startServer { request in
            request.path == "/old"
                ? .init(status: 302, headers: ["Location": "/new"], body: "moved")
                : .init(body: "final")
        }
        let collector = EventCollectorBox()
        let buffer = SdkEventBuffer(maxBufferSize: 100, flushIntervalMs: 60000) { collector.set($0) }
        AutoMobileNetwork.shared.initialize(bundleId: "test", buffer: buffer)
        let delegate = AppTaskDelegate()

        let (data, response) = try await get("old", delegate: delegate)

        XCTAssertEqual(response.statusCode, 200)
        XCTAssertEqual(text(data), "final")
        XCTAssertEqual(server?.requests.map(\.path), ["/old", "/new"])
        XCTAssertTrue(delegate.redirects.isEmpty, "the app's redirect delegate is not consulted")
        buffer.flush()
        let events = collector.events.compactMap { $0 as? SdkNetworkRequestEvent }
        XCTAssertEqual(events.map(\.statusCode), [200], "one record carrying the final response")
    }

    // MARK: #10139 authentication challenges

    func testHTTPBasicChallengeReachesTheAppDelegateWhichSuppliesTheCredential() async throws {
        try startServer { request in
            request.headers["authorization"] == "Basic dTpw"
                ? .init(body: "secret")
                : .init(status: 401, headers: ["WWW-Authenticate": "Basic realm=\"r\""], body: "denied")
        }
        let delegate = AppTaskDelegate()
        delegate.challengeAnswer = (.useCredential, URLCredential(user: "u", password: "p", persistence: .none))

        let (data, response) = try await get("secure", delegate: delegate)

        XCTAssertEqual(delegate.challengeMethods, [NSURLAuthenticationMethodHTTPBasic])
        XCTAssertEqual(response.statusCode, 200)
        XCTAssertEqual(text(data), "secret")
    }

    func testChallengeCancelledByTheAppFailsTheRequest() async throws {
        try startServer { _ in
            .init(status: 401, headers: ["WWW-Authenticate": "Basic realm=\"r\""], body: "denied")
        }
        let delegate = AppTaskDelegate()
        delegate.challengeAnswer = (.cancelAuthenticationChallenge, nil)

        do {
            _ = try await get("secure", delegate: delegate)
            XCTFail("a cancelled challenge must fail the request")
        } catch let error as URLError {
            XCTAssertEqual(error.code, .cancelled)
        }
        XCTAssertEqual(delegate.challengeMethods, [NSURLAuthenticationMethodHTTPBasic])
    }

    func testDefaultHandlingLeavesTheServerResponseUntouched() async throws {
        try startServer { _ in
            .init(status: 401, headers: ["WWW-Authenticate": "Basic realm=\"r\""], body: "denied")
        }

        let (_, response) = try await get("secure", delegate: AppTaskDelegate())

        XCTAssertEqual(response.statusCode, 401)
    }

    func testForwardedChallengeKeepsProtectionSpaceAndSenderAnswersTheInnerChallenge() {
        for method in [
            NSURLAuthenticationMethodClientCertificate,
            NSURLAuthenticationMethodServerTrust,
            NSURLAuthenticationMethodNTLM,
        ] {
            let client = ForwardingRecordingClient()
            let proto = AutoMobileURLProtocol(
                request: URLRequest(url: URL(string: "https://api.example.com/x")!), cachedResponse: nil, client: client
            )
            let space = URLProtectionSpace(
                host: "api.example.com", port: 443, protocol: "https", realm: nil, authenticationMethod: method
            )
            let inner = URLAuthenticationChallenge(
                protectionSpace: space, proposedCredential: nil, previousFailureCount: 0,
                failureResponse: nil, error: nil, sender: ForwardingRecordingClient.InertSender()
            )
            let outcome = ChallengeOutcome()

            proto.forwardChallenge(inner, completionHandler: outcome.complete)

            XCTAssertEqual(client.calls, ["challenge"], method)
            let forwarded = try? XCTUnwrap(client.challenge)
            XCTAssertEqual(forwarded?.protectionSpace.authenticationMethod, method)
            XCTAssertEqual(forwarded?.protectionSpace.host, "api.example.com")
            XCTAssertTrue(outcome.outcomes.isEmpty, "the inner challenge waits for the app's answer")

            let credential = URLCredential(user: "u", password: "p", persistence: .none)
            forwarded?.sender?.use(credential, for: forwarded!)
            forwarded?.sender?.cancel(forwarded!) // second answer is ignored

            XCTAssertEqual(outcome.outcomes.count, 1)
            XCTAssertEqual(outcome.outcomes.first?.0, .useCredential)
            XCTAssertEqual(outcome.outcomes.first?.1, credential)
        }
    }

    func testChallengeSenderMapsEveryClientAnswerToADisposition() {
        let challenge = URLAuthenticationChallenge(
            protectionSpace: URLProtectionSpace(
                host: "h", port: 443, protocol: "https", realm: nil,
                authenticationMethod: NSURLAuthenticationMethodServerTrust
            ),
            proposedCredential: nil, previousFailureCount: 0, failureResponse: nil, error: nil,
            sender: ForwardingRecordingClient.InertSender()
        )
        let cases: [(String, (InnerChallengeSender) -> Void, URLSession.AuthChallengeDisposition)] = [
            ("without credential", { $0.continueWithoutCredential(for: challenge) }, .performDefaultHandling),
            ("cancel", { $0.cancel(challenge) }, .cancelAuthenticationChallenge),
            ("default", { $0.performDefaultHandling(for: challenge) }, .performDefaultHandling),
            ("reject", { $0.rejectProtectionSpaceAndContinue(with: challenge) }, .rejectProtectionSpace),
        ]
        for (name, answer, expected) in cases {
            let outcome = ChallengeOutcome()
            answer(InnerChallengeSender(outcome.complete))
            XCTAssertEqual(outcome.outcomes.map(\.0), [expected], name)
            XCTAssertNil(outcome.outcomes.first?.1, name)
        }
    }

    func testStopLoadingCancelsAChallengeTheAppNeverAnswered() {
        let client = ForwardingRecordingClient()
        let proto = AutoMobileURLProtocol(
            request: URLRequest(url: URL(string: "https://api.example.com/x")!), cachedResponse: nil, client: client
        )
        let inner = URLAuthenticationChallenge(
            protectionSpace: URLProtectionSpace(
                host: "api.example.com", port: 443, protocol: "https", realm: nil,
                authenticationMethod: NSURLAuthenticationMethodClientCertificate
            ),
            proposedCredential: nil, previousFailureCount: 0, failureResponse: nil, error: nil,
            sender: ForwardingRecordingClient.InertSender()
        )
        let outcome = ChallengeOutcome()
        proto.forwardChallenge(inner, completionHandler: outcome.complete)

        proto.stopLoading()

        XCTAssertEqual(outcome.outcomes.map(\.0), [.cancelAuthenticationChallenge])
    }

    func testChallengeArrivingAfterStopLoadingUsesDefaultHandling() {
        let client = ForwardingRecordingClient()
        let proto = AutoMobileURLProtocol(
            request: URLRequest(url: URL(string: "https://api.example.com/x")!), cachedResponse: nil, client: client
        )
        proto.stopLoading()
        let inner = URLAuthenticationChallenge(
            protectionSpace: URLProtectionSpace(
                host: "h", port: 443, protocol: "https", realm: nil,
                authenticationMethod: NSURLAuthenticationMethodServerTrust
            ),
            proposedCredential: nil, previousFailureCount: 0, failureResponse: nil, error: nil,
            sender: ForwardingRecordingClient.InertSender()
        )
        let outcome = ChallengeOutcome()

        proto.forwardChallenge(inner, completionHandler: outcome.complete)

        XCTAssertTrue(client.calls.isEmpty)
        XCTAssertEqual(outcome.outcomes.map(\.0), [.performDefaultHandling])
    }

    /// After stopLoading() the URL loading system owns the outer task again; the inner session can
    /// still deliver callbacks it had already queued. Those late callbacks must never reach the client.
    func testInnerCallbacksQueuedBeforeStopLoadingNeverReachTheClient() {
        let client = ForwardingRecordingClient()
        let url = URL(string: "https://api.example.com/old")!
        let proto = AutoMobileURLProtocol(request: URLRequest(url: url), cachedResponse: nil, client: client)
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        let task = session.dataTask(with: url) // never resumed
        let response = HTTPURLResponse(url: url, statusCode: 302, httpVersion: nil, headerFields: ["Location": "/new"])!
        let disposition = OSAllocatedUnfairLock<[URLSession.ResponseDisposition]>(initialState: [])

        proto.stopLoading()
        proto.urlSession(session, dataTask: task, didReceive: response) { result in
            disposition.withLock { $0.append(result) }
        }
        proto.urlSession(session, dataTask: task, didReceive: Data("moved".utf8))
        proto.urlSession(session, task: task, didCompleteWithError: nil)
        proto.urlSession(session, task: task, didCompleteWithError: URLError(.cancelled))

        XCTAssertEqual(client.calls, [], "a stopped protocol must not call its client")
        XCTAssertEqual(disposition.withLock { $0 }, [.cancel])
    }

    // MARK: #10139 requests the protocol declines

    func testRequestsThatCannotBeRelayedAreDeclinedSoTheAppStackHandlesThem() throws {
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        let url = URL(string: "https://api.example.com/x")!
        var upgrade = URLRequest(url: url)
        upgrade.setValue("websocket", forHTTPHeaderField: "Upgrade")

        // Declined: upload tasks (data, file, stream), web sockets, stream tasks, Upgrade requests.
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("inner-session-upload.bin")
        try Data("x".utf8).write(to: tmp)
        defer { try? FileManager.default.removeItem(at: tmp) }
        XCTAssertFalse(AutoMobileURLProtocol.canInit(with: session.uploadTask(
            with: URLRequest(url: url),
            from: Data()
        )))
        XCTAssertFalse(AutoMobileURLProtocol.canInit(with: session.uploadTask(
            with: URLRequest(url: url),
            fromFile: tmp
        )))
        XCTAssertFalse(
            AutoMobileURLProtocol
                .canInit(with: session.uploadTask(withStreamedRequest: URLRequest(url: url)))
        )
        XCTAssertFalse(
            AutoMobileURLProtocol
                .canInit(with: session.webSocketTask(with: URL(string: "wss://api.example.com/ws")!))
        )
        XCTAssertFalse(AutoMobileURLProtocol.canInit(with: session.streamTask(
            withHostName: "api.example.com",
            port: 443
        )))
        XCTAssertFalse(AutoMobileURLProtocol.canInit(with: upgrade))
        XCTAssertFalse(AutoMobileURLProtocol.canInit(with: session.dataTask(with: upgrade)))

        // Still captured: ordinary data and download tasks, with or without a body.
        var post = URLRequest(url: url)
        post.httpMethod = "POST"
        post.httpBody = Data("{}".utf8)
        XCTAssertTrue(AutoMobileURLProtocol.canInit(with: session.dataTask(with: URLRequest(url: url))))
        XCTAssertTrue(AutoMobileURLProtocol.canInit(with: session.dataTask(with: post)))
        XCTAssertTrue(AutoMobileURLProtocol.canInit(with: session.downloadTask(with: URLRequest(url: url))))
        XCTAssertTrue(AutoMobileURLProtocol.canInit(with: URLRequest(url: url)))
    }

    func testHandledMarkerStillDeclinesInnerReplays() {
        let marked = NSMutableURLRequest(url: URL(string: "https://api.example.com/x")!)
        URLProtocol.setProperty(true, forKey: AutoMobileURLProtocol.handledKey, in: marked)

        XCTAssertFalse(AutoMobileURLProtocol.canInit(with: marked as URLRequest))
    }
}

private final class EventCollectorBox: @unchecked Sendable {
    private let lock = NSLock()
    private var _events: [any SdkEvent] = []
    var events: [any SdkEvent] { lock.lock(); defer { lock.unlock() }; return _events }
    func set(_ events: [any SdkEvent]) { lock.lock(); _events = events; lock.unlock() }
}

extension ForwardingRecordingClient {
    /// Sender for synthesized inner-session challenges; the tests never answer through it.
    fileprivate final class InertSender: NSObject, URLAuthenticationChallengeSender {
        func use(_: URLCredential, for _: URLAuthenticationChallenge) {}
        func continueWithoutCredential(for _: URLAuthenticationChallenge) {}
        func cancel(_: URLAuthenticationChallenge) {}
    }
}
