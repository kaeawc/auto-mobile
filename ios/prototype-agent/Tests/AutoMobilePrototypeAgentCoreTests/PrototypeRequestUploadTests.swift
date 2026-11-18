@testable import AutoMobilePrototypeAgentCore
import Foundation
import XCTest

final class PrototypeRequestUploadTests: XCTestCase {
    private static let valid = load("valid")
    private static let invalid = load("invalid")

    override class func setUp() {
        super.setUp()
        _ = valid
        _ = invalid
    }

    private static func load(_ kind: String) -> [String: Data] {
        let directory = PrototypeSpecFixtures.directory.appendingPathComponent(kind)
        let urls = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
        return Dictionary(
            uniqueKeysWithValues: urls.filter { $0.lastPathComponent.hasPrefix("request-upload") }
                .compactMap { url in
                    guard let data = try? Data(contentsOf: url) else { return nil }
                    return (url.lastPathComponent, data)
                }
        )
    }

    private func accepts(_ name: String) throws {
        let data = try XCTUnwrap(Self.valid["request-upload\(name).json"])
        XCTAssertNoThrow(try JSONDecoder().decode(PrototypeSpec.self, from: data))
    }

    private func rejects(_ name: String) throws {
        let data = try XCTUnwrap(Self.invalid["request-upload-\(name).json"])
        let fixture = try JSONDecoder().decode(PrototypeSpecFixtures.Invalid.self, from: data)
        XCTAssertThrowsError(try fixture.decode())
    }

    func testMultipart() throws { try accepts("") }
    func testForm() throws { try accepts("-form") }
    func testFile() throws { try accepts("-file") }
    func testProgress() throws {
        try accepts("-progress")
        let data = try XCTUnwrap(Self.valid["request-upload-progress.json"])
        let spec = try JSONDecoder().decode(PrototypeSpec.self, from: data)
        XCTAssertEqual(spec.root.onTap?.first?.progressKey, "progress")
    }

    func testSixteenParts() throws { try accepts("-16-parts") }
    func testFilePath() throws { try rejects("path") }
    func testGet() throws { try rejects("get") }
    func testHead() throws { try rejects("head") }
    func testSeventeenParts() throws { try rejects("17-parts") }
    func testUnknownPart() throws { try rejects("unknown-part") }
    func testBothSources() throws { try rejects("both") }
    func testMedia() throws { try rejects("media") }
    func testStringProgress() throws { try rejects("progress-string") }
    func testUndeclaredProgress() throws { try rejects("progress-undeclared") }
    func testProgressOver() throws { try rejects("progress-over") }
    func testProgressUnder() throws { try rejects("progress-under") }
}

@MainActor
final class PrototypeRequestUploadTestsRuntime: XCTestCase {
    private func action(
        body: String, into: String = "/data/feed", via: String = "device",
        url: String = "https://public.example/upload"
    )
        -> String
    {
        """
        {"type":"request","method":"POST","url":"\(url)","via":"\(via)",
         "body":\(body),"into":"\(into)","progressKey":"progress"}
        """
    }

    private let form = #"{"form":{"q":{"value":"literal {progress}"},"n":{"value":2}}}"#

    func testFormReachesDeviceAndEventReportsZeroFileBytesAfterCompletionProgress() async throws {
        let harness = RequestHarness()
        try harness.show("[\(action(body: form))]", state: #"{"progress":88}"#)
        harness.tap()
        XCTAssertEqual(harness.session.state["progress"], .number(0))
        await harness.waitForDeviceCalls(1)
        let request = try XCTUnwrap(harness.client.requests.first)
        XCTAssertEqual(
            try String(data: XCTUnwrap(request.uploadBody).data, encoding: .utf8),
            "n=2&q=literal+%7Bprogress%7D"
        )
        XCTAssertNil(request.body)
        harness.clock.nowMilliseconds = 99
        harness.client.sendProgress(0, sent: 40)
        await harness.yield()
        XCTAssertEqual(harness.session.state["progress"], .number(0))
        harness.clock.nowMilliseconds = 100
        harness.client.sendProgress(0, sent: 40)
        await harness.yield()
        XCTAssertEqual(harness.session.state["progress"], .number(40))
        harness.clock.nowMilliseconds = 200
        harness.client.sendProgress(0, sent: 20)
        await harness.yield()
        XCTAssertEqual(harness.session.state["progress"], .number(40))
        harness.client.respond(0, body: "ok")
        await harness.driver.settled()
        XCTAssertEqual(harness.session.state["progress"], .number(100))
        XCTAssertEqual(harness.requestEvents.last?["uploadBytes"], .number(0))
        XCTAssertEqual(harness.events.last { $0.name == PrototypeRequestEvent.name }?.state["progress"], .number(100))
    }

    func testMultipartResolvesOriginalRegisteredBytesAndReportsTheirCount() async throws {
        let harness = RequestHarness()
        harness.session.uploadAssets = PrototypeUploadAssets(bytes: ["hero": Data([1, 2, 255])])
        let body = #"{"multipart":[{"name":"photo","file":{"asset":"hero"}}]}"#
        try harness.show("[\(action(body: body))]", state: #"{"progress":0}"#)
        harness.tap()
        await harness.waitForDeviceCalls(1)
        XCTAssertEqual(harness.client.requests.first?.uploadBody?.fileBytes, 3)
        harness.client.respond(0, body: "ok")
        await harness.driver.settled()
        XCTAssertEqual(harness.requestEvents.last?["uploadBytes"], .number(3))
    }

    func testUnknownAssetCompletesWithTypedFailureBeforeAnyTransport() async throws {
        let harness = RequestHarness()
        let body = #"{"file":{"asset":"missing"},"contentType":"image/png"}"#
        try harness.show("[\(action(body: body))]", state: #"{"progress":0}"#)
        harness.tap()
        await harness.driver.settled()
        XCTAssertTrue(harness.client.requests.isEmpty)
        XCTAssertTrue(harness.hostFrames.isEmpty)
        let error = harness.requestEvents.last?["error"]?.objectFields
        XCTAssertEqual(error?["code"], .string("invalid_request"))
        XCTAssertTrue(error?["message"]?.stringValue?.contains("missing") == true)
    }

    func testHostUploadFailsBeforeDaemonOrEmbeddedRouting() async throws {
        for route in 0 ..< 3 {
            let harness = RequestHarness()
            if route == 1 {
                harness.driver.updateClients(device: harness.client, hostRoute: .deviceClient)
            } else if route == 2 {
                harness.driver.updateClients(device: harness.client, hostRoute: .handler(harness.client))
            }
            try harness.show("[\(action(body: form, via: "host"))]", state: #"{"progress":0}"#)
            harness.tap()
            await harness.driver.settled()
            XCTAssertTrue(harness.hostFrames.isEmpty)
            XCTAssertTrue(harness.client.requests.isEmpty)
            XCTAssertEqual(harness.requestEvents.last?["error"]?.objectFields?["code"], .string("invalid_request"))
        }
    }

    func testDriverAlsoRefusesAlreadyResolvedHostUploadsOnEveryRoute() async {
        for route in 0 ..< 3 {
            let clock = ManualRequestClock()
            let client = FakeHttpClient()
            var frames = 0
            var responses: [PrototypeRequestResponse] = []
            let host: PrototypeRequestDriver.HostRoute = route == 0 ? .daemon { _ in frames += 1; return true }
                : route == 1 ? .deviceClient : .handler(client)
            let driver = PrototypeRequestDriver(clock: clock, device: client, hostRoute: host)
            driver.onComplete = { _, response in responses.append(response) }
            driver.perform([.start(PrototypeRequestJob(
                requestId: "r", prototypeId: "p", via: .host, method: .post, url: "https://public.example/",
                headers: [:], body: nil, timeoutMs: nil,
                uploadBody: .init(data: Data(), contentType: "application/x-www-form-urlencoded", fileBytes: 0)
            ))])
            await driver.settled()
            XCTAssertEqual(frames, 0)
            XCTAssertTrue(client.requests.isEmpty)
            XCTAssertEqual(responses, [.failed(PrototypeUploadResolver.hostRefusal, durationMs: 0)])
        }
    }

    func testHostJSONValueContainingUploadFieldNamesStillSendsAnOrdinaryFrame() async throws {
        let harness = RequestHarness()
        try harness
            .show(
                #"[{"type":"request","method":"POST","url":"https://public.example/","via":"host","body":{"value":{"file":"metadata","form":{"a":1},"multipart":true}}}]"#
            )
        harness.tap()
        XCTAssertEqual(harness.hostFrames.count, 1)
        let body = harness.hostFrames.first?["body"] as? [String: Any]
        XCTAssertEqual(body?["file"] as? String, "metadata")
        harness.dismiss()
        await harness.driver.settled()
    }

    func testConcurrentNonoverlappingUploadsShareProgressOwnedByTheLastReset() async throws {
        let harness = RequestHarness()
        try harness.show(
            "[\(action(body: form, into: "/data/first", url: "https://public.example/first")),\(action(body: form, into: "/data/second", url: "https://public.example/second"))]",
            state: #"{"progress":95}"#
        )
        harness.tap()
        await harness.waitForDeviceCalls(2)
        XCTAssertEqual(harness.driver.runningCount, 2)
        let requests = harness.client.requests
        let first = try XCTUnwrap(requests.firstIndex { $0.url == "https://public.example/first" })
        let second = try XCTUnwrap(requests.firstIndex { $0.url == "https://public.example/second" })
        harness.clock.nowMilliseconds = 100
        harness.client.sendProgress(second, sent: 25)
        await harness.yield()
        XCTAssertEqual(harness.session.state["progress"], .number(25))
        harness.clock.nowMilliseconds = 200
        harness.client.sendProgress(first, sent: 90)
        await harness.yield()
        XCTAssertEqual(harness.session.state["progress"], .number(25))
        harness.client.respond(first, body: "first")
        await harness.yield()
        XCTAssertEqual(harness.session.state["progress"], .number(25))
        harness.client.respond(second, body: "second")
        await harness.driver.settled()
        XCTAssertEqual(harness.session.state["progress"], .number(100))
        XCTAssertEqual(harness.data("/first"), .string("first"))
        XCTAssertEqual(harness.data("/second"), .string("second"))
    }

    func testRedirectByteCounterRestartDoesNotResetOrDecreaseProgress() async throws {
        let harness = RequestHarness()
        try harness.show("[\(action(body: form))]", state: #"{"progress":0}"#)
        harness.tap()
        await harness.waitForDeviceCalls(1)
        for (time, sent, expected) in [(100, 80, 80), (200, 0, 80), (300, 40, 80), (400, 90, 90)] {
            harness.clock.nowMilliseconds = time
            harness.client.sendProgress(0, sent: Int64(sent))
            await harness.yield()
            XCTAssertEqual(harness.session.state["progress"], .number(Double(expected)))
        }
        harness.client.respond(0, body: "ok")
        await harness.driver.settled()
        XCTAssertEqual(harness.session.state["progress"], .number(100))
    }

    func testDismissalDropsLateUploadProgress() async throws {
        let harness = RequestHarness()
        try harness.show("[\(action(body: form))]", state: #"{"progress":0}"#)
        harness.tap()
        await harness.waitForDeviceCalls(1)
        harness.dismiss()
        let state = harness.session.state
        harness.clock.nowMilliseconds = 1000
        harness.client.sendProgress(0, sent: 90)
        await harness.driver.settled()
        await harness.yield()
        XCTAssertEqual(harness.session.state, state)
    }
}
