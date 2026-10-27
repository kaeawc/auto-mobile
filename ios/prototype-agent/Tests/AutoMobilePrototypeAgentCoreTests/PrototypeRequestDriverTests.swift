@testable import AutoMobilePrototypeAgentCore
import XCTest

/// Fakes for the request driver: a manual clock and an HTTP client the test answers by hand, so no
/// test waits on real time or a real network.
final class ManualRequestClock: PrototypeClock {
    final class Handle: PrototypeTimerHandle {
        let delay: Int
        let fire: () -> Void
        private(set) var cancelled = false
        private(set) var fired = false
        init(delay: Int, fire: @escaping () -> Void) {
            self.delay = delay
            self.fire = fire
        }

        func cancel() { cancelled = true }
        func run() {
            guard !cancelled, !fired else { return }
            fired = true
            fire()
        }
    }

    private(set) var handles: [Handle] = []

    func schedule(afterMilliseconds: Int, _ fire: @escaping () -> Void) -> PrototypeTimerHandle {
        let handle = Handle(delay: afterMilliseconds, fire: fire)
        handles.append(handle)
        return handle
    }

    var live: [Handle] { handles.filter { !$0.cancelled && !$0.fired } }
}

/// Records each call and suspends it until the test answers; cancelling the calling task ends the
/// call with a `cancelled` failure, as the real client does.
final class FakeHttpClient: PrototypeHttpClient, @unchecked Sendable {
    private let lock = NSLock()
    private var continuations: [Int: CheckedContinuation<PrototypeHttpResponse, Error>] = [:]
    private var calls: [PrototypeHttpRequest] = []
    private var cancelledCalls: Set<Int> = []

    var requests: [PrototypeHttpRequest] { lock.withLock { calls } }
    var cancelled: Set<Int> { lock.withLock { cancelledCalls } }

    func perform(_ request: PrototypeHttpRequest) async throws -> PrototypeHttpResponse {
        let index = lock.withLock { () -> Int in
            calls.append(request)
            return calls.count - 1
        }
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                lock.withLock { continuations[index] = continuation }
                if Task.isCancelled { cancel(index) }
            }
        } onCancel: {
            cancel(index)
        }
    }

    private func cancel(_ index: Int) {
        let continuation = lock.withLock { () -> CheckedContinuation<PrototypeHttpResponse, Error>? in
            cancelledCalls.insert(index)
            return continuations.removeValue(forKey: index)
        }
        continuation?.resume(throwing: PrototypeHttpFailure(
            error: .init(.cancelled, "Request was cancelled."),
            durationMs: 0
        ))
    }

    func respond(
        _ index: Int,
        status: Int = 200,
        headers: [String: String] = [:],
        body: String = "",
        durationMs: Int = 9
    ) {
        let continuation = lock.withLock { continuations.removeValue(forKey: index) }
        continuation?.resume(returning: PrototypeHttpResponse(
            status: status, headers: headers, body: Data(body.utf8), durationMs: durationMs
        ))
    }

    func fail(_ index: Int, _ code: PrototypeRequestErrorCode, durationMs: Int = 3) {
        let continuation = lock.withLock { continuations.removeValue(forKey: index) }
        continuation?.resume(throwing: PrototypeHttpFailure(error: .init(code, "failed"), durationMs: durationMs))
    }
}

/// A session wired to a driver the way `PrototypeModel` wires them: every transition publishes its
/// events and hands its request commands to the driver, and every completion is a transition.
@MainActor
final class RequestHarness {
    var session = PrototypeSession()
    private(set) var events: [PrototypeEvent] = []
    private(set) var hostFrames: [[String: Any]] = []
    var hostConnected = true
    let clock = ManualRequestClock()
    let client = FakeHttpClient()
    private(set) var driver: PrototypeRequestDriver!

    init(device: Bool = true) {
        driver = PrototypeRequestDriver(clock: clock, device: device ? client : nil) { [unowned self] frame in
            guard hostConnected else { return false }
            hostFrames.append(frame)
            return true
        }
        driver.onComplete = { [unowned self] requestId, response in
            apply { $0.completeRequest(requestId, response) }
        }
    }

    func show(_ onTap: String, state: String = #"{"status":"idle","loaded":false}"#, id: String = "p1") throws {
        let json = """
        {"id":"\(id)","window":{"placement":{"type":"fullscreen"}},"state":\(state),"data":{"title":"Feed"},
         "root":{"type":"button","label":"Go","onTap":\(onTap)}}
        """
        let spec = try JSONDecoder().decode(PrototypeSpec.self, from: Data(json.utf8))
        var next = session
        next.show(spec)
        let commands = next.takeRequestCommands()
        session = next
        driver.perform(commands)
    }

    func tap() {
        let actions = session.spec?.root.onTap ?? []
        apply { $0.run(actions) }
    }

    func dismiss() {
        apply { $0.dismiss(reason: .user) }
    }

    private func apply(_ transition: (inout PrototypeSession) -> [PrototypeEvent]) {
        var next = session
        let produced = next.transition(transition)
        let commands = next.takeRequestCommands()
        session = next
        events += produced
        driver.perform(commands)
    }

    func data(_ pointer: String) -> JSONValue? {
        PrototypeDataPointer.resolve(session.data, pointer: pointer)
    }

    var requestEvents: [[String: JSONValue]] {
        events.compactMap { event in
            guard event.name == PrototypeRequestEvent.name,
                  case let .object(payload) = event.payload else { return nil }
            return payload
        }
    }

    /// Lets cancelled tasks run to their end; `settled()` would also wait for the live ones.
    func yield() async {
        for _ in 0 ..< 50 {
            await Task.yield()
        }
    }

    /// Lets the tasks the driver started reach their first suspension.
    func waitForDeviceCalls(_ count: Int) async {
        for _ in 0 ..< 200 where client.requests.count < count {
            await Task.yield()
        }
    }
}

@MainActor
final class PrototypeRequestDriverTests: XCTestCase {
    func testDeliveryBoundaryChecksSuccessAndFailureAndKeepsCurrentResponse() async throws {
        for revoked in [false, true] {
            for fails in [false, true] {
                let harness = RequestHarness()
                let client = DeliveryCheckingClient(fails: fails)
                PrototypeNetworkConfiguration(device: client).apply(to: harness.driver)
                try harness.show(request(via: "device"))
                harness.tap()
                client.setCurrent(!revoked)
                await harness.driver.settled()
                if revoked {
                    XCTAssertNil(harness.data("/feed"))
                    XCTAssertEqual(harness.data("/feed__meta/error/code"), .string("blocked_destination"))
                    XCTAssertEqual(
                        harness.data("/feed__meta/error/message"),
                        .string("Network is disabled for imported prototypes.")
                    )
                    XCTAssertEqual(harness.data("/feed__meta/durationMs"), .number(0))
                } else if fails {
                    XCTAssertEqual(
                        harness.data("/feed__meta/error/message"), .string(PrototypeLocalNetworkDenied.message)
                    )
                } else {
                    XCTAssertEqual(harness.data("/feed"), .string("ok"))
                    XCTAssertEqual(harness.data("/feed__meta/status"), .number(200))
                }
            }
        }
    }

    private func request(
        via: String = "host", extra: String = "", into: String = "/data/feed"
    )
        -> String
    {
        #"""
        [{"type":"request","url":"http://localhost:8080/feed","into":"\#(into)",
          "statusKey":"status","via":"\#(via)"\#(extra)}]
        """#
    }

    private func hostResponse(
        _ id: String, ok: Bool = true, status: Int = 200, body: Any = ["n": 1] as [String: Any], durationMs: Int = 12
    )
        -> [String: Any]
    {
        ok
            ? [
                "type": "prototype_response",
                "requestId": id,
                "ok": true,
                "status": status,
                "headers": ["content-type": "application/json"],
                "body": body,
                "durationMs": durationMs
            ]
            : [
                "type": "prototype_response",
                "requestId": id,
                "ok": false,
                "error": ["code": "timeout", "message": "slow"],
                "durationMs": durationMs,
            ]
    }

    // MARK: Host

    func testAHostRequestSendsOneFrameAndCompletesOnItsResponse() throws {
        let harness = RequestHarness()
        try harness.show(request(extra: #","timeoutMs":4000,"headers":{"Accept":"application/json"}"#))
        harness.tap()
        XCTAssertEqual(harness.hostFrames.count, 1)
        let frame = try XCTUnwrap(harness.hostFrames.first)
        XCTAssertEqual(frame["type"] as? String, "prototype_request")
        XCTAssertEqual(frame["requestId"] as? String, "r-1")
        XCTAssertEqual(frame["prototypeId"] as? String, "p1")
        XCTAssertEqual(frame["method"] as? String, "GET")
        XCTAssertEqual(frame["url"] as? String, "http://localhost:8080/feed")
        XCTAssertEqual(frame["headers"] as? [String: String], ["Accept": "application/json"])
        XCTAssertEqual(frame["timeoutMs"] as? Int, 4000)
        XCTAssertEqual(harness.session.state["status"], .string("loading"))

        harness.driver.receiveHostResponse(hostResponse("r-1"))
        XCTAssertEqual(harness.session.state["status"], .string("success"))
        XCTAssertEqual(harness.data("/feed"), .object(["n": .number(1)]))
        XCTAssertEqual(harness.requestEvents.first?["via"], .string("host"))
        XCTAssertEqual(harness.requestEvents.first?["durationMs"], .number(12))
        XCTAssertEqual(harness.clock.live.count, 0, "the watchdog is cancelled by the answer")
    }

    func testAHostFailureFrameBecomesTheTypedError() throws {
        let harness = RequestHarness()
        try harness.show(request())
        harness.tap()
        harness.driver.receiveHostResponse(hostResponse("r-1", ok: false))
        XCTAssertEqual(harness.session.state["status"], .string("error"))
        XCTAssertEqual(harness.data("/feed__meta/error/code"), .string("timeout"))
        XCTAssertNil(harness.data("/feed"))
    }

    func testASilentHostEndsAtTheWatchdogWithTimeout() throws {
        let harness = RequestHarness()
        try harness.show(request(extra: #","timeoutMs":1000"#))
        harness.tap()
        let watchdog = try XCTUnwrap(harness.clock.live.first)
        XCTAssertEqual(watchdog.delay, 1000 + PrototypeRequestDriver.hostGraceMs)
        watchdog.run()
        XCTAssertEqual(harness.data("/feed__meta/error/code"), .string("timeout"))
        XCTAssertEqual(harness.data("/feed__meta/durationMs"), .number(3000))
        XCTAssertEqual(harness.session.state["status"], .string("error"))
        // A response that shows up afterwards is stale.
        harness.driver.receiveHostResponse(hostResponse("r-1"))
        XCTAssertNil(harness.data("/feed"))
    }

    func testTheDefaultHostDeadlineIsTheContractDefaultPlusGrace() throws {
        let harness = RequestHarness()
        try harness.show(request())
        harness.tap()
        XCTAssertEqual(harness.clock.live.first?.delay, 10000 + 2000)
    }

    func testAStaleHostResponseForACancelledRequestIsIgnored() throws {
        let harness = RequestHarness()
        try harness.show(request())
        harness.tap()
        harness.tap()
        XCTAssertEqual(harness.hostFrames.compactMap { $0["requestId"] as? String }, ["r-1", "r-2"])
        // r-1 was superseded: its answer changes nothing, r-2's lands.
        harness.driver.receiveHostResponse(hostResponse("r-1", body: ["old": true] as [String: Any]))
        XCTAssertNil(harness.data("/feed"))
        XCTAssertEqual(harness.session.state["status"], .string("loading"))
        harness.driver.receiveHostResponse(hostResponse("r-2", body: ["new": true] as [String: Any]))
        XCTAssertEqual(harness.data("/feed"), .object(["new": .bool(true)]))
        let outcomes = harness.requestEvents.map { $0["requestId"]?.stringValue ?? "" }
        XCTAssertEqual(outcomes, ["r-1", "r-2"])
        XCTAssertEqual(harness.requestEvents[0]["error"]?.objectValue?["code"], .string("cancelled"))
    }

    func testNoConnectedHostFailsTheRequestAsynchronouslyWithNetwork() async throws {
        let harness = RequestHarness()
        harness.hostConnected = false
        try harness.show(request())
        harness.tap()
        XCTAssertEqual(
            harness.session.state["status"],
            .string("loading"),
            "delivery is never inside the starting transition"
        )
        await harness.driver.settled()
        XCTAssertEqual(harness.session.state["status"], .string("error"))
        XCTAssertEqual(harness.data("/feed__meta/error/code"), .string("network"))
        XCTAssertTrue(harness.data("/feed__meta/error/message")?.stringValue?.contains("No AutoMobile host") == true)
    }

    func testTheHostLeavingFailsPendingHostRequestsAtOnce() async throws {
        let harness = RequestHarness()
        try harness.show(request())
        harness.tap()
        harness.driver.hostDisconnected()
        await harness.driver.settled()
        XCTAssertEqual(harness.session.state["status"], .string("error"))
        XCTAssertEqual(harness.data("/feed__meta/error/code"), .string("network"))
        XCTAssertEqual(harness.clock.live.count, 0)
    }

    func testLosingTheOwningConnectionFailsItsRequestWhileOtherHostsStay() async throws {
        let harness = RequestHarness()
        var settled: [String] = []
        harness.driver.onHostSettled = { settled.append($0) }
        try harness.show(request())
        harness.tap()
        let id = try XCTUnwrap(harness.hostFrames.first?["requestId"] as? String)
        harness.driver.hostRequestsLost(["not-pending"])
        harness.driver.hostRequestsLost([id])
        await harness.driver.settled()
        XCTAssertEqual(harness.session.state["status"], .string("error"))
        XCTAssertEqual(harness.data("/feed__meta/error/code"), .string("network"))
        XCTAssertEqual(harness.clock.live.count, 0)
        XCTAssertEqual(settled, [id])
    }

    func testASupersededHostRequestSendsACancelFrameWithNoOtherFields() async throws {
        let harness = RequestHarness()
        var cancels: [[String: Any]] = []
        harness.driver.onHostCancel = { cancels.append($0) }
        try harness.show(request())
        harness.tap()
        harness.tap()
        let ids = harness.hostFrames.compactMap { $0["requestId"] as? String }
        XCTAssertEqual(ids, ["r-1", "r-2"])
        XCTAssertEqual(cancels.count, 1)
        XCTAssertEqual(cancels.first?["type"] as? String, "prototype_request_cancel")
        XCTAssertEqual(cancels.first?["requestId"] as? String, "r-1")
        XCTAssertEqual(cancels.first?.count, 2)
    }

    func testAnAnsweredOrLostHostRequestSendsNoCancel() async throws {
        let harness = RequestHarness()
        var cancels: [[String: Any]] = []
        harness.driver.onHostCancel = { cancels.append($0) }
        try harness.show(request())
        harness.tap()
        harness.driver.receiveHostResponse(["type": "prototype_response", "requestId": "r-1"])
        harness.driver.hostRequestsLost(["r-1"])
        XCTAssertTrue(cancels.isEmpty)
    }

    func testDismissingForgetsHostRequestsAndTheirWatchdogs() throws {
        let harness = RequestHarness()
        try harness.show(request())
        harness.tap()
        harness.dismiss()
        XCTAssertEqual(harness.clock.live.count, 0)
        XCTAssertEqual(harness.driver.runningCount, 0)
        harness.driver.receiveHostResponse(hostResponse("r-1"))
        XCTAssertFalse(harness.session.isShown)
    }

    func testResponsesForUnknownIdsAndMalformedFramesAreDropped() throws {
        let harness = RequestHarness()
        try harness.show(request())
        harness.tap()
        harness.driver.receiveHostResponse(hostResponse("nope"))
        harness.driver.receiveHostResponse(["type": "prototype_response", "requestId": "r-1"])
        XCTAssertEqual(harness.session.state["status"], .string("loading"))
        XCTAssertEqual(harness.driver.runningCount, 1)
    }

    // MARK: Device

    func testADeviceRequestRunsOnTheClientAndMapsAJSONBody() async throws {
        let harness = RequestHarness()
        try harness.show(request(
            via: "device",
            extra: #","method":"POST","body":{"value":{"a":1.5,"b":[true,null]}},"headers":{"Accept":"*/*"}"#
        ))
        harness.tap()
        XCTAssertTrue(harness.hostFrames.isEmpty)
        await harness.waitForDeviceCalls(1)
        let call = try XCTUnwrap(harness.client.requests.first)
        XCTAssertEqual(call.method, .post)
        XCTAssertEqual(call.url, "http://localhost:8080/feed")
        XCTAssertEqual(call.timeoutMs, 10000)
        XCTAssertEqual(call.maxResponseBytes, PrototypeLimits.maxResponseBytes)
        XCTAssertEqual(call.headers, ["Accept": "*/*", "Content-Type": "application/json"])
        XCTAssertEqual(call.body.map { String(decoding: $0, as: UTF8.self) }, #"{"a":1.5,"b":[true,null]}"#)

        harness.client.respond(
            0,
            status: 201,
            headers: ["content-type": "application/json"],
            body: #"{"id":7}"#,
            durationMs: 21
        )
        await harness.driver.settled()
        XCTAssertEqual(harness.data("/feed"), .object(["id": .number(7)]))
        XCTAssertEqual(harness.session.state["status"], .string("success"))
        XCTAssertEqual(harness.requestEvents.first?["via"], .string("device"))
        XCTAssertEqual(harness.requestEvents.first?["durationMs"], .number(21))
        XCTAssertEqual(harness.requestEvents.first?["status"], .number(201))
    }

    func testADeviceTextBodyIsStoredAsAStringAndAnEmptyOneAsEmptyString() async throws {
        let harness = RequestHarness()
        try harness.show(request(via: "device"))
        harness.tap()
        await harness.waitForDeviceCalls(1)
        harness.client.respond(0, body: "not json {")
        await harness.driver.settled()
        XCTAssertEqual(harness.data("/feed"), .string("not json {"))
        harness.tap()
        await harness.waitForDeviceCalls(2)
        harness.client.respond(1, status: 204)
        await harness.driver.settled()
        XCTAssertEqual(harness.data("/feed"), .string(""))
        XCTAssertEqual(harness.data("/feed__meta/status"), .number(204))
    }

    func testADeviceFailureCarriesItsTypedErrorAndDuration() async throws {
        let harness = RequestHarness()
        try harness.show(request(via: "device"))
        harness.tap()
        await harness.waitForDeviceCalls(1)
        harness.client.fail(0, .connectionRefused, durationMs: 5)
        await harness.driver.settled()
        XCTAssertEqual(harness.data("/feed__meta/error/code"), .string("connection_refused"))
        XCTAssertEqual(harness.data("/feed__meta/durationMs"), .number(5))
        XCTAssertEqual(harness.session.state["status"], .string("error"))
    }

    func testBlockedDestinationReachesDeviceMetadataAndEvent() async throws {
        let harness = RequestHarness()
        try harness.show(request(via: "device"))
        harness.tap()
        await harness.waitForDeviceCalls(1)
        harness.client.fail(0, .blockedDestination)
        await harness.driver.settled()
        XCTAssertEqual(harness.data("/feed__meta/error/code"), .string("blocked_destination"))
        XCTAssertEqual(harness.requestEvents.first?["error"]?.objectValue?["code"], .string("blocked_destination"))
        XCTAssertNil(harness.data("/feed"))
    }

    func testANon2xxDeviceResponseIsAnHttpError() async throws {
        let harness = RequestHarness()
        try harness.show(request(via: "device"))
        harness.tap()
        await harness.waitForDeviceCalls(1)
        harness.client.respond(0, status: 500, body: "oops")
        await harness.driver.settled()
        XCTAssertNil(harness.data("/feed"))
        XCTAssertEqual(harness.data("/feed__meta/error/message"), .string("HTTP 500"))
    }

    func testALatestWinsCancelCancelsTheDeviceTaskAndIgnoresItsAnswer() async throws {
        let harness = RequestHarness()
        try harness.show(request(via: "device"))
        harness.tap()
        await harness.waitForDeviceCalls(1)
        harness.tap()
        await harness.waitForDeviceCalls(2)
        await harness.yield()
        XCTAssertEqual(harness.client.cancelled, [0])
        XCTAssertEqual(harness.session.state["status"], .string("loading"))
        XCTAssertNil(harness.data("/feed__meta"), "a cancelled request writes nothing")
        harness.client.respond(1, body: #""fresh""#)
        await harness.driver.settled()
        XCTAssertEqual(harness.data("/feed"), .string("fresh"))
        XCTAssertEqual(harness.requestEvents.map { $0["requestId"]?.stringValue ?? "" }, ["r-1", "r-2"])
    }

    func testEmbeddedStopDismissalCancelsRunningTasksOnBothRoutes() async throws {
        for via in ["device", "host"] {
            let harness = RequestHarness()
            PrototypeNetworkConfiguration(device: harness.client).apply(to: harness.driver)
            try harness.show(request(via: via))
            harness.tap()
            await harness.waitForDeviceCalls(1)
            XCTAssertEqual(harness.client.requests.count, 1)
            XCTAssertEqual(harness.driver.runningCount, 1)

            // PrototypeEmbeddedController.stop() dismisses the session before its final storage flush.
            harness.dismiss()
            XCTAssertEqual(harness.driver.runningCount, 0)
            let events = harness.events
            await harness.yield()
            XCTAssertEqual(harness.client.cancelled, [0])
            XCTAssertEqual(harness.events, events, "the cancelled task's answer must not reach the stopped session")
            XCTAssertNil(harness.data("/feed"))
            XCTAssertFalse(harness.session.isShown)
        }
    }

    func testAnAgentWithoutAClientFailsDeviceRequestsWithAHint() async throws {
        let harness = RequestHarness(device: false)
        try harness.show(request(via: "device"))
        harness.tap()
        await harness.driver.settled()
        XCTAssertEqual(harness.data("/feed__meta/error/code"), .string("network"))
        XCTAssertTrue(harness.data("/feed__meta/error/message")?.stringValue?.contains("via \"host\"") == true)
    }

    func testHostAndDeviceRequestsShareTheInFlightLimit() async throws {
        let harness = RequestHarness()
        let list = (0 ..< 5).map {
            #"""
            {"type":"request","url":"http://h/\#($0)","into":"/data/o\#($0)",
             "via":"\#($0 % 2 == 0 ? "host" : "device")"}
            """#
        }.joined(separator: ",")
        try harness.show("[\(list)]")
        harness.tap()
        await harness.waitForDeviceCalls(2)
        XCTAssertEqual(harness.driver.runningCount, PrototypeLimits.maxRequestsInFlight)
        XCTAssertEqual(harness.data("/o4__meta/error/code"), .string("too_many_in_flight"))
    }

    // MARK: Request building

    func testRequestBodyEncoding() {
        func job(
            _ method: PrototypeRequestMethod,
            _ body: JSONValue?,
            _ headers: [String: String] = [:]
        )
            -> PrototypeHttpRequest
        {
            PrototypeHttpRequest(job: PrototypeRequestJob(
                requestId: "r", prototypeId: "p", via: .device, method: method, url: "http://h/", headers: headers,
                body: body, timeoutMs: 99999
            ))
        }
        XCTAssertEqual(job(.post, .string("raw")).body, Data("raw".utf8))
        XCTAssertEqual(job(.post, .string("raw")).headers["Content-Type"], "text/plain; charset=utf-8")
        XCTAssertEqual(job(.put, .number(2)).body, Data("2".utf8))
        XCTAssertEqual(job(.put, .number(2)).headers["Content-Type"], "application/json")
        XCTAssertEqual(job(.patch, .object(["a/b": .string("é\"")])).body, Data(#"{"a/b":"é\""}"#.utf8))
        XCTAssertEqual(job(.post, .object([:]), ["content-type": "text/x"]).headers, ["content-type": "text/x"])
        XCTAssertNil(job(.get, .object([:])).body)
        XCTAssertNil(job(.head, .string("x")).body)
        XCTAssertEqual(
            job(.post, nil).timeoutMs,
            PrototypeLimits.maxRequestTimeoutMs,
            "the deadline is clamped to the contract maximum"
        )
    }

    func testRequestBodyKeysAreSerializedInSortedOrderRecursively() {
        let body: JSONValue = .object([
            "b": .number(1), "a": .object(["z": .bool(true), "y": .null]), "10": .string("x"), "9": .array([
                .object(["q": .number(1), "p": .number(2)]),
            ]),
        ])
        XCTAssertEqual(
            PrototypeJSONText.string(body),
            #"{"10":"x","9":[{"p":2,"q":1}],"a":{"y":null,"z":true},"b":1}"#
        )
    }

    func testBodyDecoding() {
        XCTAssertEqual(PrototypeHttpBody.decode(Data()), .null)
        XCTAssertEqual(
            PrototypeHttpBody.decode(Data("  {\"a\": [1, 2]} ".utf8)),
            .object(["a": .array([.number(1), .number(2)])])
        )
        XCTAssertEqual(PrototypeHttpBody.decode(Data("42".utf8)), .number(42))
        XCTAssertEqual(PrototypeHttpBody.decode(Data("\"s\"".utf8)), .string("s"))
        XCTAssertEqual(PrototypeHttpBody.decode(Data("<html>".utf8)), .string("<html>"))
        XCTAssertEqual(PrototypeHttpBody.decode(Data([0xFF, 0x41])), .string("\u{FFFD}A"))
        let head = PrototypeHttpResponse(status: 200, headers: [:], body: Data("x".utf8), durationMs: 1)
        XCTAssertEqual(
            head.requestResponse(for: .head),
            .received(status: 200, headers: [:], body: .null, durationMs: 1)
        )
    }
}

extension JSONValue {
    fileprivate var objectValue: [String: JSONValue]? {
        if case let .object(fields) = self { return fields }
        return nil
    }
}

private final class DeliveryCheckingClient: PrototypeHttpClient, @unchecked Sendable {
    private let lock = NSLock()
    private var current = true
    private let fails: Bool

    init(fails: Bool) { self.fails = fails }
    func setCurrent(_ value: Bool) { lock.withLock { current = value } }
    private func isCurrent() -> Bool { lock.withLock { current } }

    func perform(_: PrototypeHttpRequest) async throws -> PrototypeHttpResponse {
        if fails {
            throw PrototypeHttpFailure(
                error: .init(.network, PrototypeLocalNetworkDenied.message), durationMs: 7, localNetworkDenied: true
            )
        }
        return PrototypeHttpResponse(status: 200, headers: [:], body: Data("ok".utf8), durationMs: 7)
    }

    func perform(
        _ request: PrototypeHttpRequest, delivery: PrototypeDeliveryCheck
    )
        async throws -> PrototypeHttpResponse
    {
        delivery.bind(isCurrent: { self.isCurrent() }, obsolete: PrototypeLibraryGatedClient.disabled)
        return try await perform(request)
    }
}
