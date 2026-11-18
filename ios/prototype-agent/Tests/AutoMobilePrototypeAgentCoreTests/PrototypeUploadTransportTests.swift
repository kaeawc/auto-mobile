@testable import AutoMobilePrototypeAgentCore
import Foundation
import XCTest
#if canImport(FoundationNetworking)
    import FoundationNetworking
#endif

final class PrototypeUploadTransportTests: XCTestCase {
    private struct Inputs: PrototypeEmitContextInputs {
        func state(_ key: String) -> JSONValue? { key == "caption" ? .string("{literal} café") : nil }
        func page(_: String) -> Int? { nil }
        func data(_: String) -> JSONValue? { nil }
    }

    private struct Boundary: PrototypeUploadBoundaryGenerating {
        func nextBoundary() -> String { "fixed-boundary" }
    }

    private func resolve(_ json: String, assets: [String: Data] = [:]) throws -> PrototypeUploadBody {
        try PrototypeUploadResolver.resolve(
            JSONDecoder().decode(JSONValue.self, from: Data(json.utf8)), inputs: Inputs(),
            assets: PrototypeUploadAssets(bytes: assets), boundary: Boundary()
        )
    }

    func testMultipartUsesExactOriginalBytesAndDefaultsWithoutInterpolatingBoundStrings() throws {
        let upload = try resolve(
            #"{"multipart":[{"name":"caption","value":{"state":"caption"}},{"name":"photo","file":{"asset":"hero"}}]}"#,
            assets: ["hero": Data([0, 255, 10])]
        )
        var expected = Data((
            "--fixed-boundary\r\nContent-Disposition: form-data; name=\"caption\"\r\n\r\n{literal} café\r\n" +
                "--fixed-boundary\r\nContent-Disposition: form-data; name=\"photo\"; filename=\"hero\"\r\n" +
                "Content-Type: application/octet-stream\r\n\r\n"
        ).utf8)
        expected.append(Data([0, 255, 10]))
        expected.append(Data("\r\n--fixed-boundary--\r\n".utf8))
        XCTAssertEqual(upload.data, expected)
        XCTAssertEqual(upload.fileBytes, 3)
        XCTAssertEqual(upload.contentType, "multipart/form-data; boundary=fixed-boundary")
    }

    func testMultipartHonorsFilenameAndTypeAndEscapesQuotedParameters() throws {
        let upload = try resolve(
            #"{"multipart":[{"name":"a\"\r\n","filename":"photo.png","contentType":"image/png","file":{"asset":"hero"}}]}"#,
            assets: ["hero": Data([42])]
        )
        let text = try XCTUnwrap(String(data: upload.data, encoding: .utf8))
        XCTAssertTrue(text.contains("name=\"a%22%0D%0A\"; filename=\"photo.png\"\r\n"))
        XCTAssertTrue(text.contains("Content-Type: image/png\r\n"))
    }

    func testMultipartLeavesBackslashesAloneLikeOkHttp() throws {
        // OkHttp MultipartBody.appendQuotedString escapes only \n, \r and " (to %0A, %0D, %22).
        let upload = try resolve(
            #"{"multipart":[{"name":"a\\b","filename":"c\\d\"e","file":{"asset":"hero"}}]}"#,
            assets: ["hero": Data([42])]
        )
        let text = try XCTUnwrap(String(data: upload.data, encoding: .utf8))
        XCTAssertTrue(text.contains(#"name="a\b"; filename="c\d%22e""#))
    }

    func testFormEncoderPreservesEveryByteEscapeAndUnescapedCharacter() {
        XCTAssertEqual(PrototypeRequestURL.formComponent("AZaz09*-._ ~!+é"), "AZaz09*-._+%7E%21%2B%C3%A9")
        XCTAssertEqual(PrototypeRequestURL.formComponent("\0\r\n"), "%00%0D%0A")
    }

    func testFormEncodesUnicodeSpacesAndJSONValuesCanonically() throws {
        let upload = try resolve(
            #"{"form":{"a b":{"value":"a+b & café"},"array":{"value":[2,true]},"object":{"value":{"z":1,"a":false}},"number":{"value":1e-7}}}"#
        )
        XCTAssertEqual(
            String(data: upload.data, encoding: .utf8),
            "a+b=a%2Bb+%26+caf%C3%A9&array=%5B2%2Ctrue%5D&number=1e-7&object=%7B%22a%22%3Afalse%2C%22z%22%3A1%7D"
        )
        XCTAssertEqual(upload.contentType, "application/x-www-form-urlencoded")
        XCTAssertEqual(upload.fileBytes, 0)
    }

    func testRawFileUsesOnlyRegisteredBytesAndDeclaredType() throws {
        let upload = try resolve(
            #"{"file":{"asset":"hero"},"contentType":"image/png"}"#, assets: ["hero": Data([1, 2, 255])]
        )
        XCTAssertEqual(upload, .init(data: Data([1, 2, 255]), contentType: "image/png", fileBytes: 3))
    }

    func testUnknownAndPathEscapeAssetIdsFailWithTheIdInsteadOfReadingFiles() {
        for id in ["missing", "../../secret", "/etc/passwd"] {
            XCTAssertThrowsError(try resolve(
                "{\"file\":{\"asset\":\"\(id)\"},\"contentType\":\"image/png\"}"
            )) { error in
                XCTAssertEqual((error as? PrototypeRequestError)?.code, .invalidRequest)
                XCTAssertTrue((error as? PrototypeRequestError)?.message.contains(id) == true)
            }
        }
    }

    func testAggregateFileBytesCannotExceedTheContractLimit() throws {
        XCTAssertEqual(PrototypeLimits.maxUploadBytes, PrototypeContractValidator.limit("MAX_PROTOTYPE_UPLOAD_BYTES"))
        let bytes = Data(repeating: 1, count: PrototypeLimits.maxUploadBytes / 2 + 1)
        XCTAssertThrowsError(try resolve(
            #"{"multipart":[{"name":"a","file":{"asset":"hero"}},{"name":"b","file":{"asset":"hero"}}]}"#,
            assets: ["hero": bytes]
        )) { error in
            XCTAssertEqual((error as? PrototypeRequestError)?.code, .invalidRequest)
            XCTAssertTrue((error as? PrototypeRequestError)?.message.contains("smaller assets") == true)
        }
        XCTAssertThrowsError(try resolve(
            #"{"file":{"asset":"huge"},"contentType":"image/png"}"#,
            assets: ["huge": Data(repeating: 0, count: PrototypeLimits.maxUploadBytes + 1)]
        )) { XCTAssertEqual(($0 as? PrototypeRequestError)?.code, .invalidRequest) }
    }

    func testMissingBoundUploadValueIsTypedFailure() {
        XCTAssertThrowsError(try resolve(#"{"form":{"q":{"data":"/missing"}}}"#)) {
            XCTAssertEqual(($0 as? PrototypeRequestError)?.code, .invalidRequest)
        }
    }

    func testGeneratedContentTypeOverridesAuthoredTypeForAllUploadForms() throws {
        for body in [
            #"{"form":{"q":{"value":"ok"}}}"#,
            #"{"multipart":[{"name":"photo","file":{"asset":"hero"}}]}"#,
            #"{"file":{"asset":"hero"},"contentType":"image/png"}"#,
        ] {
            let upload = try resolve(body, assets: ["hero": Data([42])])
            let job = PrototypeRequestJob(
                requestId: "r", prototypeId: "p", via: .device, method: .post, url: "https://public.example/",
                headers: ["content-TYPE": "wrong"], body: nil, timeoutMs: nil, uploadBody: upload
            )
            let request = PrototypeHttpRequest(job: job)
            XCTAssertNil(request.body)
            XCTAssertEqual(request.uploadBody, upload)
            XCTAssertEqual(request.headers, ["Content-Type": upload.contentType])
            let payload = PrototypeRequestEvent.payload(
                job: job, into: nil, meta: PrototypeRequestMeta(.received(
                    status: 200,
                    headers: [:],
                    body: .null,
                    durationMs: 0
                ))
            )
            XCTAssertEqual(payload.objectFields?["uploadBytes"], .number(Double(upload.fileBytes)))
        }
    }

    func testProgressUsesTenHertzThrottleAndNeverDecreasesAcrossRedirectHops() {
        var tracker = PrototypeUploadProgress()
        XCTAssertEqual(tracker.reset(key: "p", requestId: "first", nowMs: 0), 0)
        XCTAssertNil(tracker.advance(key: "p", requestId: "first", value: 20, nowMs: 99))
        XCTAssertEqual(tracker.advance(key: "p", requestId: "first", value: 40, nowMs: 100), 40)
        XCTAssertNil(tracker.advance(key: "p", requestId: "first", value: 50, nowMs: 199))
        // 307/308 restart the byte count without resetting the request's progress key.
        XCTAssertNil(tracker.advance(key: "p", requestId: "first", value: 0, nowMs: 200))
        XCTAssertNil(tracker.advance(key: "p", requestId: "first", value: 39, nowMs: 300))
        XCTAssertNil(tracker.advance(key: "p", requestId: "first", value: 40, nowMs: 400))
        XCTAssertEqual(tracker.advance(key: "p", requestId: "first", value: 80, nowMs: 500), 80)
        XCTAssertEqual(tracker.advance(key: "p", requestId: "first", value: 100, nowMs: 501, completed: true), 100)
    }

    func testOnlyTheLastRequestToResetAKeyCanAdvanceOrFinishIt() {
        var tracker = PrototypeUploadProgress()
        _ = tracker.reset(key: "p", requestId: "first", nowMs: 0)
        XCTAssertEqual(tracker.advance(key: "p", requestId: "first", value: 80, nowMs: 100), 80)
        XCTAssertEqual(tracker.reset(key: "p", requestId: "second", nowMs: 150), 0)
        XCTAssertNil(tracker.advance(key: "p", requestId: "first", value: 90, nowMs: 300))
        XCTAssertNil(tracker.advance(key: "p", requestId: "first", value: 100, nowMs: 300, completed: true))
        tracker.finish(key: "p", requestId: "first")
        XCTAssertEqual(tracker.advance(key: "p", requestId: "second", value: 25, nowMs: 300), 25)
        tracker.finish(key: "p", requestId: "second")
        XCTAssertNil(tracker.advance(key: "p", requestId: "second", value: 100, nowMs: 500))
    }
}

extension PrototypeUploadTransportTests {
    private final class ProgressSamples: @unchecked Sendable {
        private let lock = NSLock()
        private var samples: [Int64] = []
        var values: [Int64] { lock.withLock { samples } }
        func append(_ sent: Int64) { lock.withLock { samples.append(sent) } }
    }

    func testPinnedClientTransmitsUploadAndResendsOnlyForPreservingRedirects() async throws {
        for status in [301, 302, 303, 307, 308] {
            let first = FakePinnedConnection(
                "HTTP/1.1 \(status) Redirect\r\nLocation: https://public.example/target\r\nContent-Length: 0\r\n\r\n"
            )
            let second = FakePinnedConnection()
            let client = PrototypePinnedHttpClient(
                resolver: FakeHostResolver(), connector: FakePinnedConnector([first, second]),
                deadlines: FakePinnedDeadline()
            )
            let request = PrototypeHttpRequest(job: PrototypeRequestJob(
                requestId: "r", prototypeId: "p", via: .device, method: .post, url: "https://public.example/",
                headers: [:], body: nil, timeoutMs: 1000,
                uploadBody: .init(data: Data("abc".utf8), contentType: "image/png", fileBytes: 3)
            ))
            let samples = ProgressSamples()
            _ = try await client.perform(request, delivery: PrototypeDeliveryCheck(), uploadProgress: { sent, _ in
                samples.append(sent)
            })
            XCTAssertTrue(first.sent.hasSuffix("\r\n\r\nabc"))
            XCTAssertTrue(first.sent.contains("Content-Type: image/png"))
            if status == 307 || status == 308 {
                XCTAssertTrue(second.sent.hasSuffix("\r\n\r\nabc"))
                XCTAssertEqual(samples.values, [3, 3])
            } else {
                XCTAssertTrue(second.sent.hasPrefix("GET /target"))
                XCTAssertFalse(second.sent.contains("Content-Type"))
                XCTAssertFalse(second.sent.hasSuffix("abc"))
                XCTAssertEqual(samples.values, [3])
            }
        }
    }
}

extension PrototypeUploadTransportTests {
    private func uploadRequest() -> PrototypeHttpRequest {
        PrototypeHttpRequest(job: PrototypeRequestJob(
            requestId: "r", prototypeId: "p", via: .device, method: .post, url: "https://public.example/",
            headers: [:], body: nil, timeoutMs: 1000,
            uploadBody: .init(data: Data("abc".utf8), contentType: "image/png", fileBytes: 3)
        ))
    }

    @MainActor
    func testLibraryConsentWrapperForwardsUploadBytesAndProgress() async throws {
        let gate = PrototypeLibraryNetworkGate(enabled: true)
        let connection = FakePinnedConnection()
        let pinned = PrototypePinnedHttpClient(
            resolver: FakeHostResolver(), connector: FakePinnedConnector([connection]), deadlines: FakePinnedDeadline()
        )
        let gated = PrototypeLibraryGatedClient(gate: gate, factory: { _ in
            PrototypeNetworkConfiguration(device: pinned)
        })
        let delivery = PrototypeDeliveryCheck()
        let samples = ProgressSamples()
        _ = try await gated.perform(uploadRequest(), delivery: delivery, uploadProgress: { sent, _ in
            samples.append(sent)
        })
        XCTAssertTrue(connection.sent.hasSuffix("abc"))
        XCTAssertEqual(samples.values, [3])
        gate.setEnabled(false)
        XCTAssertEqual(delivery.obsoleteFailure(), PrototypeLibraryGatedClient.disabled)
    }

    func testEmbeddedAppHookReceivesUploadBytesAndGeneratedType() async throws {
        let configuration = PrototypeNetworkConfiguration(deviceClient: { request in
            guard let url = request.url, let response = HTTPURLResponse(
                url: url, statusCode: 200, httpVersion: nil,
                headerFields: ["x-upload-type": request.value(forHTTPHeaderField: "Content-Type") ?? "missing"]
            ) else { throw URLError(.badURL) }
            return (request.httpBody ?? Data(), response)
        })
        let samples = ProgressSamples()
        let response = try await configuration.device.perform(
            uploadRequest(), delivery: PrototypeDeliveryCheck(), uploadProgress: { sent, _ in samples.append(sent) }
        )
        XCTAssertEqual(response.body, Data("abc".utf8))
        XCTAssertEqual(response.headers["x-upload-type"], "image/png")
        XCTAssertEqual(samples.values, [3])
    }

    private struct LegacyClient: PrototypeHttpClient {
        func perform(_: PrototypeHttpRequest) async throws -> PrototypeHttpResponse {
            .init(status: 200, headers: [:], body: Data(), durationMs: 0)
        }
    }

    func testLegacyClientDefaultOverloadRefusesUploadsInsteadOfDroppingTheirBody() async {
        do {
            _ = try await LegacyClient().perform(
                uploadRequest(), delivery: PrototypeDeliveryCheck(), uploadProgress: nil
            )
            XCTFail("An upload-unaware client accepted the body")
        } catch let failure as PrototypeHttpFailure {
            XCTAssertEqual(failure.error.code, .invalidRequest)
        } catch { XCTFail("Unexpected error: \(error)") }
    }

    func testRepeatResolvesNestedUploadBindingsAndKeepsLiteralStrings() throws {
        let row = PrototypeRepeatInstance(alias: "row", item: ["title": .string("{literal}")], index: 2)
        for body in [
            #"{"form":{"title":{"item":"title"},"index":{"index":true}}}"#,
            #"{"multipart":[{"name":"title","value":{"item":"title"}},{"name":"index","value":{"index":true}}]}"#,
        ] {
            let action = try JSONDecoder().decode(JSONValue.self, from: Data((
                "{\"type\":\"request\",\"method\":\"POST\",\"url\":\"https://public.example/\",\"body\":" + body + "}"
            ).utf8))
            let bound = try XCTUnwrap(row.bindAction(action).objectFields?["body"])
            let upload = try PrototypeUploadResolver.resolve(
                bound, inputs: Inputs(), assets: nil, boundary: Boundary()
            )
            let text = try XCTUnwrap(String(data: upload.data, encoding: .utf8))
            if body.contains("multipart") {
                XCTAssertTrue(text.contains("\r\n\r\n{literal}\r\n"))
                XCTAssertTrue(text.contains("\r\n\r\n2\r\n"))
            } else {
                XCTAssertEqual(text, "index=2&title=%7Bliteral%7D")
            }
        }
    }
}

extension PrototypeUploadTransportTests {
    func testURLSessionDelegateForwardsUploadByteCounts() async throws {
        let request = uploadRequest()
        let urlRequest = try XCTUnwrap(PrototypeURLSessionClient.urlRequest(for: request))
        let samples = ProgressSamples()
        let call = PrototypeURLSessionCall(
            maxBytes: 100, timeoutMs: 1000, request: urlRequest, uploadBody: request.uploadBody?.data,
            uploadProgress: { sent, _ in samples.append(sent) }
        )
        let session = URLSession(
            configuration: PrototypeURLSessionClient
                .configuration(protocolClasses: [StubProtocol.self])
        )
        defer { session.invalidateAndCancel() }
        let uploadData = try XCTUnwrap(request.uploadBody?.data)
        let task = session.uploadTask(with: urlRequest, from: uploadData)
        let delegate = PrototypeURLSessionDelegate(
            egress: PrototypeRequestEgressCheck(policy: .init(), resolver: FakeHostResolver()),
            metrics: FakeConnectionMetrics.allowed
        )
        let _: PrototypeHttpResponse = try await withCheckedThrowingContinuation { continuation in
            call.install(continuation)
            delegate.register(call, for: PrototypeURLSessionTaskHandle(task))
            delegate.urlSession(session, task: task, didSendBodyData: 2, totalBytesSent: 2, totalBytesExpectedToSend: 3)
            delegate.urlSession(session, task: task, didSendBodyData: 1, totalBytesSent: 3, totalBytesExpectedToSend: 3)
            _ = call.accept(status: 200, headers: [:], expectedLength: 0)
            call.finish(error: nil, measuredMs: 0)
        }
        XCTAssertEqual(samples.values, [2, 3])
    }
}
