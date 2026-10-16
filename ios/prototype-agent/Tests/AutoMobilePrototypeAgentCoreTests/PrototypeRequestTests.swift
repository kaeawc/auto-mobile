@testable import AutoMobilePrototypeAgentCore
import XCTest

/// The `request` action (#12529) in the device-free session: lifecycle, response handling, error
/// mapping, latest-wins, the in-flight limit, cancellation, binding resolution, validation and the
/// shared fixture. The driver and the HTTP clients have their own suites.
final class PrototypeRequestTests: XCTestCase {
    // MARK: Helpers

    private func spec(
        state: String = #"{"status":"idle","loaded":false}"#,
        data: String = #"{"title":"Feed"}"#,
        onTap: String,
        id: String = "p1"
    )
        throws -> PrototypeSpec
    {
        let json = """
        {"id":"\(id)","window":{"placement":{"type":"fullscreen"}},"state":\(state),"data":\(data),
         "root":{"type":"button","label":"Go","onTap":\(onTap)}}
        """
        return try JSONDecoder().decode(PrototypeSpec.self, from: Data(json.utf8))
    }

    private func shown(
        state: String = #"{"status":"idle","loaded":false}"#,
        data: String = #"{"title":"Feed"}"#,
        onTap: String
    )
        throws -> (PrototypeSession, [PrototypeAction])
    {
        let built = try spec(state: state, data: data, onTap: onTap)
        var session = PrototypeSession()
        session.show(built)
        return try (session, XCTUnwrap(built.root.onTap))
    }

    private let feed =
        #"[{"type":"request","url":"http://localhost:8080/feed","into":"/data/feed","statusKey":"status","#
            +
            #""onSuccess":[{"type":"setState","key":"loaded","value":true}],"onError":[{"type":"emit","name":"failed"}]}]"#

    private func labels(_ events: [PrototypeEvent]) -> [String] {
        events.map { "\($0.kind):\($0.name ?? "-")" }
    }

    private func requestEvent(_ events: [PrototypeEvent]) throws -> [String: JSONValue] {
        let event = try XCTUnwrap(events.first { $0.kind == "emit" && $0.name == PrototypeRequestEvent.name })
        guard case let .object(payload) = event.payload else { throw XCTSkip("payload is not an object") }
        return payload
    }

    private func ok(
        _ body: JSONValue, status: Int = 200, headers: [String: String] = [:], durationMs: Int = 31
    )
        -> PrototypeRequestResponse
    {
        .received(status: status, headers: headers, body: body, durationMs: durationMs)
    }

    private func failed(_ code: PrototypeRequestErrorCode, _ message: String = "m") -> PrototypeRequestResponse {
        .failed(PrototypeRequestError(code, message), durationMs: 7)
    }

    // MARK: Lifecycle

    func testTapSetsLoadingAndIssuesOneStartCommand() throws {
        var (session, actions) = try shown(onTap: feed)
        let events = session.run(actions)
        XCTAssertEqual(session.state["status"], .string("loading"))
        XCTAssertEqual(labels(events), ["emit:change"])
        guard case let .start(job)? = session.takeRequestCommands().first else { return XCTFail("no start") }
        XCTAssertEqual(job.requestId, "r-1")
        XCTAssertEqual(job.prototypeId, "p1")
        XCTAssertEqual(job.method, .get)
        XCTAssertEqual(job.via, .host)
        XCTAssertEqual(job.url, "http://localhost:8080/feed")
        XCTAssertEqual(session.requests.inFlight.count, 1)
    }

    func testSuccessWritesIntoMetaStatusEventThenOnSuccessInOrder() throws {
        var (session, actions) = try shown(onTap: feed)
        _ = session.run(actions)
        let body = JSONValue.object(["items": .array([.number(1), .number(2)])])
        let events = session.completeRequest(
            "r-1", ok(body, headers: ["content-type": "application/json"])
        )
        XCTAssertEqual(
            labels(events),
            ["change:/data/feed", "change:/data/feed__meta", "emit:change", "emit:prototype_request", "emit:change"]
        )
        XCTAssertEqual(PrototypeDataPointer.resolve(session.data, pointer: "/feed"), body)
        XCTAssertEqual(PrototypeDataPointer.resolve(session.data, pointer: "/feed__meta"), .object([
            "status": .number(200),
            "headers": .object(["content-type": .string("application/json")]),
            "durationMs": .number(31),
        ]))
        XCTAssertEqual(session.state["status"], .string("success"))
        XCTAssertEqual(session.state["loaded"], .bool(true))
        XCTAssertEqual(try requestEvent(events), [
            "requestId": .string("r-1"), "method": .string("GET"), "via": .string("host"),
            "url": .string("http://localhost:8080/feed"), "into": .string("/data/feed"),
            "outcome": .string("success"), "status": .number(200), "durationMs": .number(31),
        ])
        XCTAssertTrue(session.requests.inFlight.isEmpty)
    }

    func testTheRequestEventFollowsTheDataWritesAndPrecedesTheFollowUp() throws {
        var (session, actions) = try shown(onTap: feed)
        _ = session.run(actions)
        let events = session.completeRequest("r-1", ok(.string("x")))
        let order = labels(events)
        XCTAssertLessThan(
            try XCTUnwrap(order.firstIndex(of: "change:/data/feed__meta")),
            try XCTUnwrap(order.firstIndex(of: "emit:prototype_request"))
        )
        XCTAssertEqual(order.last, "emit:change")
        // Sequences are consecutive from the show's own.
        XCTAssertEqual(events.map(\.sequence), Array(events[0].sequence ..< events[0].sequence + events.count))
    }

    func testNonJSONBodyIsStoredAsAStringAndAnEmptyBodyAsEmptyString() throws {
        var (session, actions) = try shown(onTap: feed)
        _ = session.run(actions)
        _ = session.completeRequest("r-1", ok(.string("plain text")))
        XCTAssertEqual(PrototypeDataPointer.resolve(session.data, pointer: "/feed"), .string("plain text"))
        _ = session.run(actions)
        _ = session.completeRequest("r-2", ok(.null))
        XCTAssertEqual(PrototypeDataPointer.resolve(session.data, pointer: "/feed"), .string(""))
    }

    func testHeadStoresAnEmptyStringWhateverTheClientReturned() throws {
        var (
            session,
            actions
        ) = try shown(onTap: #"[{"type":"request","method":"HEAD","url":"http://h/x","into":"/data/head"}]"#)
        _ = session.run(actions)
        _ = session.completeRequest("r-1", ok(.string("ignored")))
        XCTAssertEqual(PrototypeDataPointer.resolve(session.data, pointer: "/head"), .string(""))
    }

    // MARK: Failures

    func testNon2xxLeavesIntoAloneWritesMetaWithHttpErrorAndRunsOnError() throws {
        var (session, actions) = try shown(onTap: feed)
        _ = session.run(actions)
        let events = session.completeRequest("r-1", ok(.string("nope"), status: 404, headers: ["x": "y"]))
        XCTAssertNil(PrototypeDataPointer.resolve(session.data, pointer: "/feed"))
        XCTAssertEqual(PrototypeDataPointer.resolve(session.data, pointer: "/feed__meta/error"), .object([
            "code": .string("http_error"), "message": .string("HTTP 404"),
        ]))
        XCTAssertEqual(PrototypeDataPointer.resolve(session.data, pointer: "/feed__meta/status"), .number(404))
        XCTAssertEqual(session.state["status"], .string("error"))
        XCTAssertEqual(session.state["loaded"], .bool(false))
        XCTAssertEqual(
            labels(events),
            ["change:/data/feed__meta", "emit:change", "emit:prototype_request", "emit:failed"]
        )
        let payload = try requestEvent(events)
        XCTAssertEqual(payload["outcome"], .string("error"))
        XCTAssertEqual(payload["status"], .number(404))
        XCTAssertEqual(payload["error"], .object(["code": .string("http_error"), "message": .string("HTTP 404")]))
    }

    func testEveryTransportFailureCodeReachesMetaAndTheEventWithoutAStatus() throws {
        for code in PrototypeRequestErrorCode.allCases where code != .httpError && code != .invalidResponse {
            var (session, actions) = try shown(onTap: feed)
            _ = session.run(actions)
            let events = session.completeRequest("r-1", failed(code, "boom"))
            let meta = PrototypeDataPointer.resolve(session.data, pointer: "/feed__meta")
            XCTAssertEqual(meta, .object([
                "durationMs": .number(7),
                "error": .object(["code": .string(code.rawValue), "message": .string("boom")]),
            ]), code.rawValue)
            let payload = try requestEvent(events)
            XCTAssertNil(payload["status"], code.rawValue)
            XCTAssertEqual(payload["outcome"], .string("error"), code.rawValue)
            XCTAssertEqual(session.state["status"], .string("error"), code.rawValue)
            XCTAssertNil(PrototypeDataPointer.resolve(session.data, pointer: "/feed"), code.rawValue)
        }
    }

    func testABodyDataCannotHoldIsInvalidResponseAndLeavesIntoAlone() throws {
        var (session, actions) = try shown(onTap: feed)
        _ = session.run(actions)
        let events = session.completeRequest("r-1", ok(.object(["a": .null])))
        XCTAssertNil(PrototypeDataPointer.resolve(session.data, pointer: "/feed"))
        let error = PrototypeDataPointer.resolve(session.data, pointer: "/feed__meta/error/code")
        XCTAssertEqual(error, .string("invalid_response"))
        XCTAssertEqual(try requestEvent(events)["outcome"], .string("error"))
        XCTAssertEqual(session.state["status"], .string("error"))
    }

    func testMetaDropsHeadersWhenTheWholeValueDoesNotFit() throws {
        var (session, actions) = try shown(onTap: feed)
        _ = session.run(actions)
        let big = String(repeating: "h", count: PrototypeLimits.maxDataWriteBytes)
        _ = session.completeRequest("r-1", ok(.string("x"), headers: ["x-big": big]))
        XCTAssertEqual(PrototypeDataPointer.resolve(session.data, pointer: "/feed"), .string("x"))
        XCTAssertEqual(PrototypeDataPointer.resolve(session.data, pointer: "/feed__meta"), .object([
            "status": .number(200), "durationMs": .number(31),
        ]))
        XCTAssertEqual(session.state["status"], .string("success"))
    }

    func testARequestWithoutIntoWritesNoDataButStillReportsStatusAndFollowUp() throws {
        var (session, actions) = try shown(
            onTap:
            #"[{"type":"request","url":"http://h/x","statusKey":"status","onSuccess":[{"type":"setState","key":"loaded","value":true}]}]"#
        )
        _ = session.run(actions)
        let events = session.completeRequest("r-1", ok(.string("x")))
        XCTAssertEqual(session.data, ["title": .string("Feed")])
        XCTAssertEqual(labels(events), ["emit:change", "emit:prototype_request", "emit:change"])
        XCTAssertNil(try requestEvent(events)["into"])
        XCTAssertEqual(session.state["loaded"], .bool(true))
    }

    func testAnUnresolvableBindingFailsTheRequestAtOnceAsInvalidRequest() throws {
        var (session, actions) = try shown(
            onTap:
            #"[{"type":"request","url":"http://h/x","headers":{"X-A":{"state":"nope"}},"statusKey":"status","onError":[{"type":"emit","name":"bad"}]}]"#
        )
        let events = session.run(actions)
        XCTAssertTrue(session.takeRequestCommands().isEmpty)
        XCTAssertEqual(labels(events), ["emit:change", "emit:prototype_request", "emit:bad"])
        let error = try XCTUnwrap(requestEvent(events)["error"])
        XCTAssertEqual(error, .object([
            "code": .string("invalid_request"), "message": .string("headers.X-A: State key nope is not set"),
        ]))
        XCTAssertEqual(session.state["status"], .string("error"))
    }

    func testANonScalarHeaderBindingIsInvalidRequest() throws {
        var (session, actions) = try shown(
            data: #"{"obj":{"a":1}}"#,
            onTap: #"[{"type":"request","url":"http://h/x","headers":{"X-A":{"data":"/obj"}}}]"#
        )
        let events = session.run(actions)
        let message = try requestEvent(events)["error"]
        XCTAssertEqual(message, .object([
            "code": .string("invalid_request"),
            "message": .string("headers.X-A must resolve to a string, number or boolean"),
        ]))
    }

    func testAnUnparseableResolvedUrlIsInvalidUrl() throws {
        var (session, actions) = try shown(onTap: #"[{"type":"request","url":"http://{status}:99999/x"}]"#)
        let events = session.run(actions)
        XCTAssertEqual(try requestEvent(events)["error"], .object([
            "code": .string("invalid_url"), "message": .string("Not an absolute URL: http://idle:99999/x"),
        ]))
    }

    // MARK: Concurrency

    func testALaterRequestToTheSameIntoCancelsTheEarlierOne() throws {
        var (session, actions) = try shown(onTap: feed)
        _ = session.run(actions)
        _ = session.takeRequestCommands()
        let events = session.run(actions)
        XCTAssertEqual(session.takeRequestCommands().map(\.summary), ["cancel r-1", "start r-2"])
        // The older request reports `cancelled`; the status key was already loading, so no change.
        XCTAssertEqual(labels(events), ["emit:prototype_request"])
        let payload = try requestEvent(events)
        XCTAssertEqual(payload["requestId"], .string("r-1"))
        XCTAssertEqual(payload["outcome"], .string("error"))
        XCTAssertEqual(payload["error"]?.objectValue?["code"], .string("cancelled"))
        XCTAssertEqual(session.state["status"], .string("loading"))
        // The cancelled answer writes nothing, leaves the status alone and runs no follow-up.
        XCTAssertEqual(session.completeRequest("r-1", ok(.string("stale"))), [])
        XCTAssertNil(PrototypeDataPointer.resolve(session.data, pointer: "/feed"))
        XCTAssertEqual(session.state["status"], .string("loading"))
        XCTAssertEqual(session.state["loaded"], .bool(false))
        XCTAssertFalse(session.completeRequest("r-2", ok(.string("fresh"))).isEmpty)
        XCTAssertEqual(PrototypeDataPointer.resolve(session.data, pointer: "/feed"), .string("fresh"))
    }

    func testRequestsToDifferentIntoPathsRunSideBySide() throws {
        var (session, actions) = try shown(
            onTap:
            #"[{"type":"request","url":"http://h/a","into":"/data/a"},{"type":"request","url":"http://h/b","into":"/data/b"}]"#
        )
        _ = session.run(actions)
        XCTAssertEqual(session.takeRequestCommands().map(\.summary), ["start r-1", "start r-2"])
        _ = session.completeRequest("r-2", ok(.string("B")))
        _ = session.completeRequest("r-1", ok(.string("A")))
        XCTAssertEqual(PrototypeDataPointer.resolve(session.data, pointer: "/a"), .string("A"))
        XCTAssertEqual(PrototypeDataPointer.resolve(session.data, pointer: "/b"), .string("B"))
    }

    func testTheFifthRequestInFlightFailsWithTooManyInFlight() throws {
        let list = ["a", "b", "c", "d", "e"].map {
            #"{"type":"request","url":"http://h/\#($0)","into":"/data/\#($0)"}"#
        }.joined(separator: ",")
        var (session, actions) = try shown(onTap: "[\(list)]")
        let events = session.run(actions)
        XCTAssertEqual(
            session.takeRequestCommands().map(\.summary),
            ["start r-1", "start r-2", "start r-3", "start r-4"]
        )
        XCTAssertEqual(session.requests.inFlight.count, PrototypeLimits.maxRequestsInFlight)
        let last = try requestEvent(Array(events.suffix(2)))
        XCTAssertEqual(last["error"]?.objectValue?["code"], .string("too_many_in_flight"))
        XCTAssertEqual(last["into"], .string("/data/e"))
        XCTAssertEqual(
            PrototypeDataPointer.resolve(session.data, pointer: "/e__meta/error/code"), .string("too_many_in_flight")
        )
        // A finished request frees its slot.
        _ = session.completeRequest("r-1", ok(.string("A")))
        _ = session.run(Array(actions.suffix(1)))
        XCTAssertEqual(session.takeRequestCommands().map(\.summary), ["start r-6"])
    }

    func testDismissCancelsEveryRequestAndLaterAnswersChangeNothing() throws {
        var (session, actions) = try shown(onTap: feed)
        _ = session.run(actions)
        _ = session.takeRequestCommands()
        let events = session.dismiss(reason: .user)
        XCTAssertEqual(labels(events), ["dismissed:-"])
        XCTAssertEqual(session.takeRequestCommands().map(\.summary), ["cancel r-1"])
        XCTAssertEqual(session.completeRequest("r-1", ok(.string("x"))), [])
    }

    func testShowingAnotherPrototypeCancelsTheOldOnesRequestsButAReplaceKeepsThem() throws {
        var (session, actions) = try shown(onTap: feed)
        _ = session.run(actions)
        _ = session.takeRequestCommands()
        try session.show(spec(onTap: feed))
        XCTAssertTrue(session.takeRequestCommands().isEmpty, "a same-id replace keeps its requests")
        XCTAssertEqual(session.requests.inFlight.count, 1)
        try session.show(spec(onTap: feed), reset: true)
        XCTAssertEqual(session.takeRequestCommands().map(\.summary), ["cancel r-1"])
        _ = try session.run(XCTUnwrap(session.spec?.root.onTap))
        _ = session.takeRequestCommands()
        try session.show(spec(onTap: feed, id: "other"))
        XCTAssertEqual(session.takeRequestCommands().map(\.summary), ["cancel r-2"])
    }

    func testRequestIdsNeverRepeatAcrossShows() throws {
        var (session, actions) = try shown(onTap: feed)
        _ = session.run(actions)
        _ = session.dismiss(reason: .user)
        try session.show(spec(onTap: feed))
        _ = session.takeRequestCommands()
        _ = try session.run(XCTUnwrap(session.spec?.root.onTap))
        XCTAssertEqual(session.takeRequestCommands().map(\.summary), ["start r-2"])
    }

    // MARK: Follow-ups and nesting

    func testAFollowUpRequestStartsAfterTheStatusAndEvent() throws {
        var (session, actions) = try shown(
            onTap:
            #"[{"type":"request","url":"http://h/a","statusKey":"status","onSuccess":[{"type":"request","url":"http://h/b","into":"/data/b"}]}]"#
        )
        _ = session.run(actions)
        _ = session.takeRequestCommands()
        let events = session.completeRequest("r-1", ok(.string("x")))
        XCTAssertEqual(labels(events), ["emit:change", "emit:prototype_request"])
        XCTAssertEqual(session.takeRequestCommands().map(\.summary), ["start r-2"])
    }

    func testAFollowUpListIsAtomicLikeATapList() throws {
        // `loaded` is a boolean; a setState to a string breaks no binding but the list still applies once.
        var (session, actions) = try shown(
            onTap:
            #"[{"type":"request","url":"http://h/a","onSuccess":[{"type":"setState","key":"loaded","value":true},{"type":"emit","name":"done"}]}]"#
        )
        _ = session.run(actions)
        let events = session.completeRequest("r-1", ok(.string("x")))
        XCTAssertEqual(labels(events), ["emit:prototype_request", "emit:done", "emit:change"])
    }

    // MARK: Bindings

    func testBindingsResolveAtTheActionAndTheQueryIsMergedAndSetByName() throws {
        let tap = """
        [{"type":"request","method":"POST","url":"http://LOCALHOST:8080/{data:/base}/{region}/feed?page=1&keep=y",
          "headers":{"Accept":"application/json","X-Id":"id-{region}","X-N":{"data":"/n"}},
          "query":{"q":{"state":"term"},"page":{"value":2}},
          "body":{"value":{"a":[1,"x"]}},"timeoutMs":5000}]
        """
        var (session, actions) = try shown(
            state: #"{"region":"eu","term":"hello world"}"#, data: #"{"base":"api","n":5}"#, onTap: tap
        )
        _ = session.run(actions)
        guard case let .start(job)? = session.takeRequestCommands().first else { return XCTFail("no start") }
        XCTAssertEqual(job.method, .post)
        XCTAssertEqual(job.url, "http://localhost:8080/api/eu/feed?page=2&keep=y&q=hello+world")
        XCTAssertEqual(job.headers, ["Accept": "application/json", "X-Id": "id-eu", "X-N": "5"])
        XCTAssertEqual(job.body, .object(["a": .array([.number(1), .string("x")])]))
        XCTAssertEqual(job.timeoutMs, 5000)
        XCTAssertEqual(job.effectiveTimeoutMs, 5000)
    }

    func testQueryEntriesAreAppliedInSortedKeyOrderLikeTheHost() throws {
        let tap = #"[{"type":"request","url":"http://h/p","query":{"z":{"value":"1"},"a":{"value":"2"}}}]"#
        var (session, actions) = try shown(onTap: tap)
        _ = session.run(actions)
        guard case let .start(job)? = session.takeRequestCommands().first else { return XCTFail("no start") }
        XCTAssertEqual(job.url, "http://h/p?a=2&z=1")
    }

    func testTheHostFrameCarriesOnlyWhatTheFrameSchemaAllows() throws {
        var (session, actions) = try shown(onTap: feed)
        _ = session.run(actions)
        guard case let .start(job)? = session.takeRequestCommands().first else { return XCTFail("no start") }
        let frame = job.hostFrame
        XCTAssertEqual(Set(frame.keys), ["type", "requestId", "prototypeId", "method", "url"])
        XCTAssertEqual(frame["type"] as? String, "prototype_request")
        XCTAssertEqual(job.effectiveTimeoutMs, PrototypeLimits.defaultRequestTimeoutMs)
    }

    func testTheEventUrlAndMessageAreCut() {
        let job = PrototypeRequestJob(
            requestId: "r-1", prototypeId: "p", via: .device, method: .get,
            url: "http://h/" + String(repeating: "a", count: 3000), headers: [:], body: nil, timeoutMs: nil
        )
        let meta = PrototypeRequestMeta(.failed(
            PrototypeRequestError(.network, String(repeating: "m", count: 900)), durationMs: 1
        ))
        guard case let .object(payload) = PrototypeRequestEvent.payload(job: job, into: nil, meta: meta) else {
            return XCTFail("payload")
        }
        XCTAssertEqual(payload["url"]?.stringValue?.utf16.count, 2048)
        XCTAssertEqual(payload["error"]?.objectValue?["message"]?.stringValue?.utf16.count, 512)
        XCTAssertEqual(payload["via"], .string("device"))
    }

    func testRepeatRowsBindUrlIntoAndStatusKeyPerRow() throws {
        let json = """
        {"id":"rep","window":{"placement":{"type":"fullscreen"}},
         "state":{"s0":"idle","s1":"idle"},"data":{"rows":[{"id":"a"},{"id":"b"}]},
         "root":{"type":"column","repeat":{"items":{"path":"/rows"},"as":"row"},"children":[
           {"type":"button","label":"Go","onTap":[{"type":"request","url":"http://h/{row.id}/{index}",
             "into":"/data/out/{index}/res","statusKey":"s{index}","query":{"i":{"index":true},"r":{"item":"id"}},
             "headers":{"X-Row":"{row.id}"}}]}]}}
        """
        let decoded = try JSONDecoder().decode(PrototypeSpec.self, from: Data(json.utf8))
        let second = try XCTUnwrap(decoded.root.children?[1].onTap)
        var session = PrototypeSession()
        session.show(decoded)
        _ = session.run(second)
        guard case let .start(job)? = session.takeRequestCommands().first else { return XCTFail("no start") }
        XCTAssertEqual(job.url, "http://h/b/1?i=1&r=b")
        XCTAssertEqual(job.headers, ["X-Row": "b"])
        XCTAssertEqual(session.requests.inFlight.values.first?.statusKey, "s1")
        XCTAssertEqual(session.state["s1"], .string("loading"))
    }

    // MARK: Validation

    private func rejection(_ onTap: String, state: String = #"{"status":"idle","n":1}"#) -> String? {
        do {
            _ = try spec(state: state, onTap: onTap)
            return nil
        } catch let DecodingError.dataCorrupted(context) {
            return context.debugDescription
        } catch {
            return "\(error)"
        }
    }

    func testValidationMirrorsTheHostRules() {
        let cases: [(String, String)] = [
            (
                #"[{"type":"request","url":"ftp://h/x"}]"#,
                "root.onTap[0].url: A request url must be an absolute http or https URL"
            ),
            (
                #"[{"type":"request","url":"{status}://h"}]"#,
                "root.onTap[0].url: A templated request url must start with a literal http:// or https://"
            ),
            (
                #"[{"type":"request","url":"http://h","method":"TRACE"}]"#,
                "root.onTap[0].method: Expected GET, POST, PUT, PATCH, DELETE or HEAD"
            ),
            (
                #"[{"type":"request","url":"http://h","body":{"value":1}}]"#,
                "root.onTap[0].body: A GET or HEAD request cannot have a body"
            ),
            (
                #"[{"type":"request","method":"HEAD","url":"http://h","body":{"value":1}}]"#,
                "root.onTap[0].body: A GET or HEAD request cannot have a body"
            ),
            (
                #"[{"type":"request","url":"http://h","into":"/state/x"}]"#,
                "root.onTap[0].into: request into is /data/<RFC 6901 pointer> and addresses a member of data"
            ),
            (
                #"[{"type":"request","url":"http://h","into":"/data/list/0"}]"#,
                "root.onTap[0].into: request into must name an object member, not an array element, so into__meta can be written beside it"
            ),
            (
                #"[{"type":"request","url":"http://h","statusKey":"missing"}]"#,
                "root.onTap[0].statusKey: statusKey must name a declared state key"
            ),
            (
                #"[{"type":"request","url":"http://h","statusKey":"n"}]"#,
                "root.onTap[0].statusKey: statusKey requires a string state key"
            ),
            (#"[{"type":"request","url":"http://h","via":"cloud"}]"#, "root.onTap[0].via: Expected host or device"),
            (
                #"[{"type":"request","url":"http://h","timeoutMs":0}]"#,
                "root.onTap[0].timeoutMs: Expected an integer from 1 to 30000"
            ),
            (
                #"[{"type":"request","url":"http://h","timeoutMs":30001}]"#,
                "root.onTap[0].timeoutMs: Expected an integer from 1 to 30000"
            ),
            (
                #"[{"type":"request","url":"http://h","timeoutMs":1.5}]"#,
                "root.onTap[0].timeoutMs: Expected an integer from 1 to 30000"
            ),
            (
                #"[{"type":"request","url":"http://h","headers":{"bad name":"x"}}]"#,
                "root.onTap[0].headers[\"bad name\"]: Invalid header name"
            ),
            (
                #"[{"type":"request","url":"http://h","headers":{"X":{"value":[1]}}}]"#,
                "root.onTap[0].headers.X.value: A header or query literal must be a string, number or boolean"
            ),
            (
                #"[{"type":"request","url":"http://h","query":{"q":{"state":"a","data":"/b"}}}]"#,
                "root.onTap[0].query.q: Expected one value binding: state, data, value, item or index"
            ),
            (
                #"[{"type":"request","url":"http://h","onSuccess":[]}]"#,
                "root.onTap[0].onSuccess: Expected 1 to 32 actions"
            ),
            (
                #"[{"type":"emit","name":"prototype_request"}]"#,
                "root.onTap[0].name: The emit name prototype_request is reserved for request events"
            ),
        ]
        for (tap, expected) in cases {
            XCTAssertEqual(rejection(tap), expected, tap)
        }
    }

    func testMoreThanSixteenHeadersAreRefused() {
        let headers = (0 ... 16).map { #""H\#($0)":"v""# }.joined(separator: ",")
        XCTAssertEqual(
            rejection(#"[{"type":"request","url":"http://h","headers":{\#(headers)}}]"#),
            "root.onTap[0].headers: Expected an object of at most 16 entries"
        )
    }

    func testActionNestingIsBoundedByMaxActionDepth() {
        func chain(_ levels: Int) -> String {
            var tap = #"{"type":"request","url":"http://h"}"#
            for _ in 1 ..< levels {
                tap = #"{"type":"request","url":"http://h","onSuccess":[\#(tap)]}"#
            }
            return "[\(tap)]"
        }
        XCTAssertNil(rejection(chain(PrototypeLimits.maxActionDepth)))
        XCTAssertEqual(
            rejection(chain(PrototypeLimits.maxActionDepth + 1)),
            "root.onTap[0].onSuccess[0].onSuccess[0].onSuccess[0].onSuccess: Request action nesting depth limit exceeded"
        )
        XCTAssertNotNil(rejection(chain(PrototypeLimits.maxActionDepth + 1).replacingOccurrences(
            of: "onSuccess",
            with: "onError"
        )))
    }

    func testRequestsInOtherActionListsAreValidatedToo() {
        let spec = """
        {"id":"p","window":{"placement":{"type":"fullscreen"}},"state":{"s":"x"},
         "root":{"type":"column","children":[{"type":"text","text":"t","onLongPress":[{"type":"request","url":"nope"}]}]}}
        """
        XCTAssertThrowsError(try JSONDecoder().decode(PrototypeSpec.self, from: Data(spec.utf8)))
    }

    func testTheConstantsMatchTheSharedContract() throws {
        let contractURL = PrototypeSpecFixtures.directory.deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("schemas/prototype-spec-contract.json")
        let contract = try JSONSerialization.jsonObject(with: Data(contentsOf: contractURL)) as? [String: Any]
        let limits = try XCTUnwrap(contract?["limits"] as? [String: Int])
        XCTAssertEqual(PrototypeLimits.defaultRequestTimeoutMs, limits["DEFAULT_PROTOTYPE_REQUEST_TIMEOUT_MS"])
        XCTAssertEqual(PrototypeLimits.maxRequestTimeoutMs, limits["MAX_PROTOTYPE_REQUEST_TIMEOUT_MS"])
        XCTAssertEqual(PrototypeLimits.maxResponseBytes, limits["MAX_PROTOTYPE_RESPONSE_BYTES"])
        XCTAssertEqual(PrototypeLimits.maxRequestsInFlight, limits["MAX_PROTOTYPE_REQUESTS_IN_FLIGHT"])
        XCTAssertEqual(PrototypeLimits.maxActionDepth, limits["MAX_PROTOTYPE_ACTION_DEPTH"])
        XCTAssertLessThanOrEqual(PrototypeLimits.maxResponseBytes, PrototypeLimits.maxDataWriteBytes)
    }

    func testTheAgentAdvertisesBothNetworkCapabilities() {
        XCTAssertEqual(PrototypeAgentProtocol.networkCapability, "prototype_network_v1")
        XCTAssertEqual(PrototypeAgentProtocol.networkDeviceCapability, "prototype_network_device_v1")
        XCTAssertTrue(PrototypeAgentProtocol.capabilities.contains(PrototypeAgentProtocol.networkCapability))
        XCTAssertTrue(PrototypeAgentProtocol.capabilities.contains(PrototypeAgentProtocol.networkDeviceCapability))
    }

    // MARK: Shared fixture

    func testTheSharedFixtureDecodesValidatesAndRuns() throws {
        let url = PrototypeSpecFixtures.directory.appendingPathComponent("valid/request-actions.json")
        let decoded = try JSONDecoder().decode(PrototypeSpec.self, from: Data(contentsOf: url))
        let buttons = try XCTUnwrap(decoded.root.children).filter { $0.type == "button" }
        let load = try XCTUnwrap(buttons[0].onTap?.first)
        XCTAssertEqual(load.type, "request")
        XCTAssertEqual(load.via, "host")
        XCTAssertEqual(load.timeoutMs, 5000)
        XCTAssertEqual(load.onSuccess?.count, 2)
        XCTAssertNil(load.onSuccess?[1].onSuccess)
        XCTAssertEqual(load.onError?.first?.name, "feed_failed")
        let send = try XCTUnwrap(buttons[1].onTap?.first)
        XCTAssertEqual(send.via, "device")
        XCTAssertEqual(send.body, .object(["state": .string("draft")]))

        var session = PrototypeSession()
        session.show(decoded)
        _ = try session.run(XCTUnwrap(buttons[0].onTap))
        let commands = session.takeRequestCommands()
        guard case let .start(feed)? = commands.first else { return XCTFail("no start") }
        XCTAssertEqual(feed.url, "http://localhost:8080/feed?limit=20&q=cats")
        XCTAssertEqual(feed.headers, ["Accept": "application/json", "X-Title": "Feed"])
        XCTAssertEqual(feed.timeoutMs, 5000)
        XCTAssertEqual(session.state["feedStatus"], .string("loading"))
        let events = session.completeRequest("r-1", ok(.array([.string("a")])))
        XCTAssertEqual(session.state["feedStatus"], .string("success"))
        XCTAssertEqual(session.state["loaded"], .bool(true))
        // onSuccess chains a POST that has neither into nor statusKey.
        guard case let .start(seen)? = session.takeRequestCommands().first else { return XCTFail("no chained start") }
        XCTAssertEqual(seen.method, .post)
        XCTAssertEqual(seen.body, .object(["seen": .bool(true)]))
        XCTAssertEqual(try requestEvent(events)["into"], .string("/data/feed"))

        _ = try session.run(XCTUnwrap(buttons[1].onTap))
        guard case let .start(post)? = session.takeRequestCommands().last else { return XCTFail("no post") }
        XCTAssertEqual(post.url, "http://localhost:8080/items/idle")
        XCTAssertEqual(post.via, .device)
        XCTAssertEqual(post.body, .string("hello"))
    }

    // MARK: URL

    func testUrlNormalization() throws {
        let cases: [(String, String)] = [
            ("HTTP://Example.COM:80/a b?x=1#frag z", "http://example.com/a%20b?x=1#frag%20z"),
            ("https://example.com", "https://example.com/"),
            ("https://example.com:443/p", "https://example.com/p"),
            ("https://example.com:8443/p", "https://example.com:8443/p"),
            ("http://[::1]:8080/x", "http://[::1]:8080/x"),
            ("http://u:p@h/p", "http://u:p@h/p"),
            ("http://h/caf\u{E9}", "http://h/caf%C3%A9"),
            ("http://h/a%20b", "http://h/a%20b"),
        ]
        for (input, expected) in cases {
            XCTAssertEqual(try PrototypeRequestURL.resolve(input, query: []).get(), expected, input)
        }
    }

    func testUrlQueryEntriesAreSetByNameAndFormEncoded() throws {
        let merged = try PrototypeRequestURL.resolve("http://h/p?a=1&b=2&a=3", query: [("a", "9")]).get()
        XCTAssertEqual(merged, "http://h/p?a=9&b=2")
        let encoded = try PrototypeRequestURL.resolve("http://h/p", query: [("q", "a&b=c d"), ("\u{E9}", "~*")]).get()
        XCTAssertEqual(encoded, "http://h/p?q=a%26b%3Dc+d&%C3%A9=%7E*")
    }

    func testUrlQueryEntriesTouchOnlyTheirOwnPieces() throws {
        let cases: [(String, [(String, String)], String)] = [
            ("http://h.test/p?a=1&b=x%20y&a=3&c", [("a", "2")], "http://h.test/p?a=2&b=x%20y&c"),
            ("http://h.test/p?flag&x=%20", [], "http://h.test/p?flag&x=%20"),
            ("http://h.test/p?a=1", [("b", "2")], "http://h.test/p?a=1&b=2"),
            ("http://h.test/p", [("a", "2"), ("z", "1")], "http://h.test/p?a=2&z=1"),
            (
                "http://localhost:8080/feed?q=old",
                [("flag", "true"), ("n", "3"), ("q", "cats"), ("z", "9")],
                "http://localhost:8080/feed?q=cats&flag=true&n=3&z=9"
            ),
            ("http://h/p?a+b=1&c", [("a b", "x y")], "http://h/p?a+b=x+y&c"),
        ]
        for (input, query, expected) in cases {
            let named = query.map { (name: $0.0, value: $0.1) }
            XCTAssertEqual(try PrototypeRequestURL.resolve(input, query: named).get(), expected, input)
        }
    }

    func testUrlRejections() {
        let cases: [(String, String)] = [
            ("ftp://h/x", "Only http and https URLs are supported, got ftp:"),
            ("example.com/x", "Not an absolute URL: example.com/x"),
            ("http://", "Not an absolute URL: http://"),
            ("http:///x", "Not an absolute URL: http:///x"),
            ("http://h:99999/x", "Not an absolute URL: http://h:99999/x"),
            ("http://a b/x", "Not an absolute URL: http://a b/x"),
        ]
        for (input, message) in cases {
            guard case let .failure(error) = PrototypeRequestURL.resolve(input, query: []) else {
                XCTFail("accepted \(input)")
                continue
            }
            XCTAssertEqual(error.message, message, input)
        }
    }

    // MARK: Wire

    func testResponseFramesDecodeLikeTheHostSchema() throws {
        let success = try XCTUnwrap(PrototypeRequestWire.decodeResponse([
            "type": "prototype_response", "requestId": "r-1", "ok": true, "status": 201,
            "headers": ["content-type": "text/plain"], "body": ["a": [1, true, NSNull()]], "durationMs": 12,
        ]))
        XCTAssertEqual(success.requestId, "r-1")
        XCTAssertEqual(success.response, .received(
            status: 201, headers: ["content-type": "text/plain"],
            body: .object(["a": .array([.number(1), .bool(true), .null])]), durationMs: 12
        ))
        let empty = try XCTUnwrap(PrototypeRequestWire.decodeResponse([
            "type": "prototype_response", "requestId": "r-2", "ok": true, "status": 204,
            "headers": [:] as [String: String],
            "body": NSNull(), "durationMs": 1,
        ]))
        XCTAssertEqual(empty.response, .received(status: 204, headers: [:], body: .null, durationMs: 1))
        let failure = try XCTUnwrap(PrototypeRequestWire.decodeResponse([
            "type": "prototype_response", "requestId": "r-3", "ok": false,
            "error": ["code": "too_large", "message": "big"], "durationMs": 4,
        ]))
        XCTAssertEqual(failure.response, .failed(PrototypeRequestError(.tooLarge, "big"), durationMs: 4))
        let unknown = try XCTUnwrap(PrototypeRequestWire.decodeResponse([
            "type": "prototype_response", "requestId": "r-4", "ok": false,
            "error": ["code": "novel", "message": "?"], "durationMs": 0,
        ]))
        XCTAssertEqual(unknown.response, .failed(PrototypeRequestError(.network, "?"), durationMs: 0))
    }

    func testMalformedResponseFramesAreRejected() {
        for frame: [String: Any] in [
            [:], ["type": "prototype_result", "requestId": "r", "ok": true],
            ["type": "prototype_response", "ok": true, "status": 200],
            ["type": "prototype_response", "requestId": "r", "ok": true],
            ["type": "prototype_response", "requestId": "r", "ok": false],
        ] {
            XCTAssertNil(PrototypeRequestWire.decodeResponse(frame))
        }
    }

    func testOutcomeStoresHeadAndEmptyBodiesAsEmptyString() {
        XCTAssertEqual(PrototypeRequestOutcome.storedBody(.null, method: .get), .string(""))
        XCTAssertEqual(PrototypeRequestOutcome.storedBody(.string("x"), method: .head), .string(""))
        XCTAssertEqual(PrototypeRequestOutcome.storedBody(.number(0), method: .get), .number(0))
    }
}

extension PrototypeRequestCommand {
    fileprivate var summary: String {
        switch self {
        case let .start(job): "start \(job.requestId)"
        case let .cancel(requestId): "cancel \(requestId)"
        }
    }
}

extension JSONValue {
    fileprivate var objectValue: [String: JSONValue]? {
        if case let .object(fields) = self { return fields }
        return nil
    }
}
