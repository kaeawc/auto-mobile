#if DEBUG && !os(watchOS)
    @testable import AutoMobileSDK
    import Foundation
    import Network
    import os
    import XCTest

    extension SdkHierarchyServerTests {
        func testHttpCachedHierarchyWithoutSnapshotHasEmpty204Body() throws {
            try withRunningServer(tracker: HttpContractTracker()) { port in
                try assertHttpContract(
                    roundTrip(port: port, head: requestHead("GET", "/hierarchy"), body: ""),
                    status: "204 No Content", body: ""
                )
            }
        }

        func testHttpCachedHierarchyReturnsCompleteSnapshot() throws {
            let snapshot = httpSnapshot(timestamp: 123)
            try withRunningServer(tracker: HttpContractTracker(cached: snapshot)) { port in
                try assertHttpContract(
                    roundTrip(port: port, head: requestHead("GET", "/hierarchy"), body: ""),
                    status: "200 OK", body: snapshotBody(timestamp: 123), unorderedObjectKeys: true
                )
            }
        }

        func testHttpFreshHierarchyReturnsWalkRatherThanCachedSnapshot() throws {
            let tracker = HttpContractTracker(cached: httpSnapshot(timestamp: 123), fresh: httpSnapshot(timestamp: 456))
            try withRunningServer(tracker: tracker) { port in
                try assertHttpContract(
                    roundTrip(port: port, head: requestHead("GET", "/hierarchy/fresh"), body: ""),
                    status: "200 OK", body: snapshotBody(timestamp: 456), unorderedObjectKeys: true
                )
            }
        }

        func testHttpCachedHierarchyEncodingFailure() throws {
            try assertHierarchyEncodingFailure(path: "/hierarchy")
        }

        func testHttpFreshHierarchyEncodingFailure() throws {
            try assertHierarchyEncodingFailure(path: "/hierarchy/fresh")
        }

        func testHttpNetworkMockValidBody() throws {
            try assertNetworkRequest(
                "/network/mock",
                body: #"{"rules":[]}"#,
                status: "200 OK",
                expected: #"{"status":"ok","rejected":[]}"#,
                unorderedObjectKeys: true
            )
        }

        func testHttpNetworkErrorSimulationValidBody() throws {
            try assertNetworkRequest(
                "/network/error-simulation",
                body: #"{"enabled":false}"#,
                status: "200 OK",
                expected: #"{"status":"ok"}"#
            )
        }

        func testHttpNetworkFaultRulesValidBody() throws {
            try assertNetworkRequest(
                "/network/fault-rules",
                body: #"{"rules":[]}"#,
                status: "200 OK",
                expected: #"{"status":"ok"}"#
            )
        }

        func testHttpNetworkMockInvalidJson() throws {
            try assertNetworkRequest(
                "/network/mock",
                body: "{",
                status: "400 Bad Request",
                expected: #"{"error":"bad_request"}"#
            )
        }

        func testHttpNetworkErrorSimulationInvalidJson() throws {
            try assertNetworkRequest(
                "/network/error-simulation",
                body: "{",
                status: "400 Bad Request",
                expected: #"{"error":"bad_request"}"#
            )
        }

        func testHttpNetworkFaultRulesInvalidJson() throws {
            try assertNetworkRequest(
                "/network/fault-rules",
                body: "{",
                status: "400 Bad Request",
                expected: #"{"error":"bad_request"}"#
            )
        }

        func testHttpNetworkMockMissingContentLengthAndBody() throws {
            try assertMissingBody("/network/mock")
        }

        func testHttpNetworkErrorSimulationMissingContentLengthAndBody() throws {
            try assertMissingBody("/network/error-simulation")
        }

        func testHttpNetworkFaultRulesMissingContentLengthAndBody() throws {
            try assertMissingBody("/network/fault-rules")
        }

        #if !canImport(UIKit)
            func testHttpMagicTapWithoutUIKitReturns501UnknownAndEmptyBody() throws {
                try assertPost("/accessibility/magic-tap", body: "", status: "501 Unknown", expected: "")
            }

            func testHttpHighlightWithoutUIKitIsUnavailable() throws {
                try assertPost(
                    "/highlight",
                    body: "{}",
                    status: "503 Service Unavailable",
                    expected: #"{"error":"highlight_unavailable"}"#
                )
            }
        #endif

        func testHttpBodyLengthOverOneMiBIsRejectedWithoutWaitingForBody() throws {
            try assertInvalidBodyLength(1024 * 1024 + 1)
        }

        func testHttpBodyLengthExactlyOneMiBAcceptsWhitespacePaddedJson() throws {
            let prefix = #"{"rules":[]}"#
            let body = prefix + String(repeating: " ", count: 1024 * 1024 - prefix.utf8.count)
            try assertNetworkRequest(
                "/network/mock",
                body: body,
                status: "200 OK",
                expected: #"{"status":"ok","rejected":[]}"#,
                unorderedObjectKeys: true
            )
        }

        func testHttpNegativeBodyLengthIsBadRequest() throws {
            try assertInvalidBodyLength(-1)
        }

        func testHttpTruncatedBodyAtEOFClosesConnectionAndHealthStillWorks() throws {
            try withRunningServer(tracker: HttpContractTracker()) { port in
                let response = try segmentedHttpExchange(
                    port: port, head: requestHead("POST", "/network/mock", length: 100), body: "{", endOfStream: true
                )
                try assertHttpContract(response, status: "400 Bad Request", body: #"{"error":"bad_request"}"#)
                try assertContractHealth(port)
            }
        }

        func testHttpBodyArrivingAfterHeadersIsReadCompletely() throws {
            defer { clearHttpNetworkState() }
            let body = #"{"rules":[]}"#
            try withRunningServer(tracker: HttpContractTracker()) { port in
                let response = try segmentedHttpExchange(
                    port: port, head: requestHead("POST", "/network/mock", length: body.utf8.count),
                    body: body, delay: 0.01
                )
                try assertHttpContract(
                    response,
                    status: "200 OK",
                    body: #"{"status":"ok","rejected":[]}"#,
                    unorderedObjectKeys: true
                )
            }
        }

        func testHttpLowercaseContentLengthIsRecognized() throws {
            try assertContentLengthSpelling("content-length")
        }

        func testHttpUppercaseContentLengthIsRecognized() throws {
            try assertContentLengthSpelling("CONTENT-LENGTH")
        }

        // Existing trigger tests cover success; pin the malformed-body route response here.
        func testHttpTriggerMalformedPayloadHasJsonFraming() throws {
            try assertPost("/trigger", body: "{}", status: "400 Bad Request", expected: #"{"error":"bad_request"}"#)
        }

        func testHttpPreferencesForDifferentAppHasJsonFraming() throws {
            try assertPost(
                "/preferences",
                body: #"{"operation":"list","appId":"http.contract.other","suiteName":"Standard"}"#,
                status: "409 Conflict",
                expected: #"{"error":"app_id_mismatch"}"#
            )
        }

        func testHttpDatabaseListWhenInspectionDisabled() throws {
            DatabaseInspector.shared.reset()
            defer { DatabaseInspector.shared.reset() }
            try assertPost(
                "/db/list",
                body: "{}",
                status: "503 Service Unavailable",
                expected: #"{"error":"db_inspection_disabled","diagnostic":{"code":"db_inspection_disabled","message":"db_inspection_disabled"}}"#,
                unorderedObjectKeys: true
            )
        }

        func testHttpDatabaseCapabilitiesWhenInspectionDisabled() throws {
            DatabaseInspector.shared.reset()
            defer { DatabaseInspector.shared.reset() }
            try assertPost(
                "/db/capabilities",
                body: "{}",
                status: "200 OK",
                expected: #"{"readOnly":true,"mutationAuthorized":false,"registeredAppGroupSuites":[],"coreDataStores":[],"unavailableStores":["keychain","file_caches"]}"#,
                unorderedObjectKeys: true
            )
        }

        func testHttpDatabaseTablesWhenInspectionDisabled() throws {
            DatabaseInspector.shared.reset()
            defer { DatabaseInspector.shared.reset() }
            try assertPost(
                "/db/tables",
                body: #"{"databasePath":"/tmp/http-contract.db"}"#,
                status: "503 Service Unavailable",
                expected: #"{"error":"db_inspection_disabled","diagnostic":{"code":"db_inspection_disabled","message":"db_inspection_disabled"}}"#,
                unorderedObjectKeys: true
            )
        }

        func testHttpUnknownGetRouteIsNotFound() throws {
            try assertUnknownRoute(method: "GET")
        }

        func testHttpUnknownPostRouteIsNotFound() throws {
            try assertUnknownRoute(method: "POST")
        }

        func testHttpHeadHealthIsMethodNotAllowedWithAllowGet() throws {
            try assertHealthMethodNotAllowed("HEAD")
        }

        func testHttpDeleteHealthIsMethodNotAllowedWithAllowGet() throws {
            try assertHealthMethodNotAllowed("DELETE")
        }

        func testHttpEmptyConnectionClosesAndHealthStillWorks() throws {
            try withRunningServer(tracker: HttpContractTracker()) { port in
                let response = try segmentedHttpExchange(port: port, head: "", body: "", endOfStream: true)
                XCTAssertEqual(response, "")
                try assertContractHealth(port)
            }
        }

        private func httpSnapshot(timestamp: Int64) -> SdkViewHierarchy {
            SdkViewHierarchy(
                timestamp: timestamp,
                bundleId: "test.bundle",
                screenScale: 2,
                screenWidth: 320,
                screenHeight: 640,
                root: nil
            )
        }

        private func snapshotBody(timestamp: Int64) -> String {
            "{\"timestamp\":\(timestamp),\"bundleId\":\"test.bundle\",\"screenScale\":2,\"screenWidth\":320,\"screenHeight\":640}"
        }

        private func assertHierarchyEncodingFailure(path: String) throws {
            let unencodable = SdkViewHierarchy(
                timestamp: 0,
                screenScale: .nan,
                screenWidth: 0,
                screenHeight: 0,
                root: nil
            )
            try withRunningServer(tracker: HttpContractTracker(cached: unencodable, fresh: unencodable)) { port in
                try assertHttpContract(
                    roundTrip(port: port, head: requestHead("GET", path), body: ""),
                    status: "500 Internal Server Error",
                    body: #"{"error":"encode_failed"}"#
                )
            }
        }

        private func requestHead(
            _ method: String,
            _ path: String,
            length: Int? = nil,
            lengthHeader: String = "Content-Length"
        )
            -> String
        {
            let lengthLine = length.map { "\(lengthHeader): \($0)\r\n" } ?? ""
            return "\(method) \(path) HTTP/1.1\r\nHost: localhost\r\n\(lengthLine)\r\n"
        }

        private func assertPost(
            _ path: String,
            body: String,
            status: String,
            expected: String,
            unorderedObjectKeys: Bool = false
        )
            throws
        {
            try withRunningServer(tracker: HttpContractTracker()) { port in
                try assertHttpContract(
                    roundTrip(port: port, head: requestHead("POST", path, length: body.utf8.count), body: body),
                    status: status, body: expected, unorderedObjectKeys: unorderedObjectKeys
                )
            }
        }

        private func assertNetworkRequest(
            _ path: String,
            body: String,
            status: String,
            expected: String,
            unorderedObjectKeys: Bool = false
        )
            throws
        {
            defer { clearHttpNetworkState() }
            try assertPost(
                path,
                body: body,
                status: status,
                expected: expected,
                unorderedObjectKeys: unorderedObjectKeys
            )
        }

        private func clearHttpNetworkState() {
            let store = NetworkMockRuleStore.shared
            store.setRules([])
            store.clearFaultRules()
            store.setErrorSimulation(NetworkErrorSimulationDTO(
                enabled: false,
                errorType: nil,
                limit: nil,
                expiresAtEpochMs: nil
            ))
        }

        private func assertMissingBody(_ path: String) throws {
            try withRunningServer(tracker: HttpContractTracker()) { port in
                try assertHttpContract(
                    roundTrip(port: port, head: requestHead("POST", path), body: ""),
                    status: "400 Bad Request",
                    body: #"{"error":"bad_request"}"#
                )
            }
        }

        private func assertInvalidBodyLength(_ length: Int) throws {
            try withRunningServer(tracker: HttpContractTracker()) { port in
                try assertHttpContract(
                    roundTrip(port: port, head: requestHead("POST", "/network/mock", length: length), body: ""),
                    status: "400 Bad Request", body: #"{"error":"bad_request"}"#
                )
            }
        }

        private func assertContentLengthSpelling(_ name: String) throws {
            defer { clearHttpNetworkState() }
            // The suffix is invalid JSON: success proves the declared length was actually honored,
            // rather than merely accepting an unframed body (which the current reader also permits).
            let prefix = #"{"rules":[]}"#
            try withRunningServer(tracker: HttpContractTracker()) { port in
                try assertHttpContract(
                    roundTrip(
                        port: port,
                        head: requestHead("POST", "/network/mock", length: prefix.utf8.count, lengthHeader: name)
                            + prefix + "invalid suffix",
                        body: ""
                    ),
                    status: "200 OK", body: #"{"status":"ok","rejected":[]}"#, unorderedObjectKeys: true
                )
            }
        }

        private func assertUnknownRoute(method: String) throws {
            try withRunningServer(tracker: HttpContractTracker()) { port in
                try assertHttpContract(
                    roundTrip(port: port, head: requestHead(method, "/nope"), body: ""),
                    status: "404 Not Found",
                    body: #"{"error":"not_found"}"#
                )
            }
        }

        private func assertHealthMethodNotAllowed(_ method: String) throws {
            try withRunningServer(tracker: HttpContractTracker()) { port in
                let response = try roundTrip(port: port, head: requestHead(method, "/health"), body: "")
                try assertHttpContract(
                    response,
                    status: "405 Method Not Allowed",
                    body: #"{"error":"method_not_allowed"}"#
                )
                let headers = response.components(separatedBy: "\r\n\r\n")[0].components(separatedBy: "\r\n")
                XCTAssertEqual(headers.filter { $0.hasPrefix("Allow:") }, ["Allow: GET"])
            }
        }

        private func assertContractHealth(_ port: NWEndpoint.Port) throws {
            let response = try roundTrip(port: port, head: requestHead("GET", "/health"), body: "")
            let body = try XCTUnwrap(response.components(separatedBy: "\r\n\r\n").last)
            let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(body.utf8)) as? [String: Any])
            let capabilities = try XCTUnwrap(object["capabilities"] as? [String])
            #if canImport(UIKit)
                let expectedCapabilities = ["network-fault-rules", "magic-tap", "sdk-trigger"]
            #else
                let expectedCapabilities = ["network-fault-rules", "sdk-trigger"]
            #endif
            // Health encodes a Set, so capability order is also unspecified. Pin every member
            // and its multiplicity, then compare the complete payload in the observed order.
            XCTAssertEqual(capabilities.sorted(), expectedCapabilities.sorted())
            let expected = try JSONSerialization.data(withJSONObject: [
                "status": "ok", "bundleId": "test.bundle", "capabilities": capabilities,
            ])
            try assertHttpContract(
                response,
                status: "200 OK",
                body: XCTUnwrap(String(data: expected, encoding: .utf8)),
                unorderedObjectKeys: true
            )
        }

        /// Deterministic bodies are compared byte for byte. JSONEncoder does not promise object-key
        /// ordering, so its multi-key payloads are compared in full after sorting only object keys.
        private func assertHttpContract(
            _ response: String,
            status: String,
            body expectedBody: String,
            unorderedObjectKeys: Bool = false,
            file: StaticString = #filePath,
            line: UInt = #line
        )
            throws
        {
            let delimiter = try XCTUnwrap(response.range(of: "\r\n\r\n"), file: file, line: line)
            let headers = response[..<delimiter.lowerBound].components(separatedBy: "\r\n")
            let body = String(response[delimiter.upperBound...])
            XCTAssertEqual(headers.first, "HTTP/1.1 \(status)", file: file, line: line)
            XCTAssertEqual(
                headers.filter { $0.hasPrefix("Content-Type:") },
                ["Content-Type: application/json"],
                file: file,
                line: line
            )
            XCTAssertEqual(
                headers.filter { $0.hasPrefix("Content-Length:") },
                ["Content-Length: \(body.utf8.count)"],
                file: file,
                line: line
            )
            XCTAssertEqual(
                headers.filter { $0.hasPrefix("Connection:") },
                ["Connection: close"],
                file: file,
                line: line
            )
            if unorderedObjectKeys {
                let actual = try JSONSerialization.jsonObject(with: Data(body.utf8))
                let expected = try JSONSerialization.jsonObject(with: Data(expectedBody.utf8))
                XCTAssertEqual(
                    try JSONSerialization.data(withJSONObject: actual, options: [.sortedKeys]),
                    try JSONSerialization.data(withJSONObject: expected, options: [.sortedKeys]),
                    file: file,
                    line: line
                )
            } else {
                XCTAssertEqual(body, expectedBody, file: file, line: line)
            }
        }

        /// Like roundTrip, but can deliberately defer the body or half-close the write side for EOF.
        /// Receiving through EOF also verifies that the server closes the connection after its reply.
        private func segmentedHttpExchange(
            port: NWEndpoint.Port,
            head: String,
            body: String,
            delay: TimeInterval = 0,
            endOfStream: Bool = false
        )
            throws -> String
        {
            let connection = NWConnection(host: "127.0.0.1", port: port, using: .tcp)
            let queue = DispatchQueue(label: "sdk-http-contract-client")
            let closed = expectation(description: "server closes connection")
            let response = OSAllocatedUnfairLock(initialState: Data())
            @Sendable
            func receive() {
                connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, complete, error in
                    if let data { response.withLock { $0.append(data) } }
                    if complete || error != nil {
                        closed.fulfill()
                    } else {
                        receive()
                    }
                }
            }
            connection.stateUpdateHandler = { state in
                guard case .ready = state else { return }
                connection.send(content: Data(head.utf8), completion: .contentProcessed { _ in
                    queue.asyncAfter(deadline: .now() + delay) {
                        connection.send(
                            content: Data(body.utf8),
                            contentContext: endOfStream ? .finalMessage : .defaultMessage,
                            isComplete: true,
                            completion: .contentProcessed { _ in }
                        )
                    }
                })
                receive()
            }
            connection.start(queue: queue)
            defer { connection.cancel() }
            wait(for: [closed], timeout: 5)
            return String(data: response.withLock { $0 }, encoding: .utf8) ?? ""
        }
    }

    private final class HttpContractTracker: SdkHierarchyServing {
        let bundleId: String? = "test.bundle"
        let isApplicationActive = true
        private let cached: SdkViewHierarchy?
        private let fresh: SdkViewHierarchy

        init(cached: SdkViewHierarchy? = nil, fresh: SdkViewHierarchy? = nil) {
            self.cached = cached
            self.fresh = fresh ?? SdkViewHierarchy(
                timestamp: 0,
                screenScale: 1,
                screenWidth: 0,
                screenHeight: 0,
                root: nil
            )
        }

        func getLatestHierarchy() -> SdkViewHierarchy? { cached }
        func walkNow() -> SdkViewHierarchy { fresh }
    }
#endif
