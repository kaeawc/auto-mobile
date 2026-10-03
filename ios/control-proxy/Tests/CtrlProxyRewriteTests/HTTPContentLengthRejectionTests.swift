@testable import CtrlProxyRewrite
import Foundation
import XCTest

final class HTTPContentLengthRejectionTests: XCTestCase {
    func testMalformedContentLengthsAreBadRequests() {
        for value in HTTPContentLengthFixture.invalidValues {
            XCTAssertEqual(
                RewriteFraming.classifyHTTPRequest(in: HTTPContentLengthFixture.request(lengths: [value])),
                .rejected(.badRequest),
                value
            )
        }
    }

    func testOverLimitAndOverflowingContentLengthsArePayloadTooLarge() {
        for value in HTTPContentLengthFixture.oversizedValues {
            XCTAssertEqual(
                RewriteFraming.classifyHTTPRequest(in: HTTPContentLengthFixture.request(lengths: [value])),
                .rejected(.payloadTooLarge),
                value
            )
        }
    }

    func testEveryDuplicateIsValidatedAndBadSyntaxWinsOverOverflow() {
        let invalid = HTTPContentLengthFixture.negativeLength
        let valid = HTTPContentLengthFixture.validLength
        let overflow = HTTPContentLengthFixture.overflowingLength
        for lengths in [[valid, invalid], [invalid, valid], [overflow, invalid], [invalid, overflow]] {
            XCTAssertEqual(
                RewriteFraming.classifyHTTPRequest(in: HTTPContentLengthFixture.request(lengths: lengths)),
                .rejected(.badRequest)
            )
        }
        XCTAssertEqual(
            RewriteFraming.classifyHTTPRequest(in: HTTPContentLengthFixture.request(lengths: [valid, overflow])),
            .rejected(.payloadTooLarge)
        )
    }

    func testValidDuplicatesKeepFirstLength() {
        let request = HTTPContentLengthFixture.request(
            lengths: [HTTPContentLengthFixture.validLength, HTTPContentLengthFixture.secondValidLength],
            body: HTTPContentLengthFixture.body
        )
        XCTAssertEqual(RewriteFraming.classifyHTTPRequest(in: request), .complete(length: request.count))
    }

    func testInvalidUTF8HeaderIsBadRequest() {
        let request = Data(HTTPContentLengthFixture.requestLine.utf8)
            + Data([HTTPContentLengthFixture.invalidUTF8Byte])
            + Data(HTTPContentLengthFixture.headerSeparator.utf8)
        XCTAssertEqual(RewriteFraming.classifyHTTPRequest(in: request), .rejected(.badRequest))
    }

    func testTotalRequestBudgetIncludesHeadersAndAllowsExactLimit() {
        let template = HTTPContentLengthFixture.request(lengths: [HTTPContentLengthFixture.boundaryLengthTemplate])
        let bodyLength = WebSocketFraming.maximumHTTPRequestLength - template.count
        let atLimit = HTTPContentLengthFixture.request(lengths: [String(bodyLength)])
        XCTAssertEqual(atLimit.count + bodyLength, WebSocketFraming.maximumHTTPRequestLength)
        XCTAssertEqual(RewriteFraming.classifyHTTPRequest(in: atLimit), .incomplete)

        let overLimit = HTTPContentLengthFixture.request(lengths: [String(bodyLength + 1)])
        XCTAssertEqual(overLimit.count + bodyLength + 1, WebSocketFraming.maximumHTTPRequestLength + 1)
        XCTAssertEqual(RewriteFraming.classifyHTTPRequest(in: overLimit), .rejected(.payloadTooLarge))
    }

    func testCompleteAndPartialBodiesAndIncompleteHeaders() {
        let complete = HTTPContentLengthFixture.request(
            lengths: [HTTPContentLengthFixture.validLength], body: HTTPContentLengthFixture.body
        )
        let partial = HTTPContentLengthFixture.request(
            lengths: [HTTPContentLengthFixture.validLength], body: HTTPContentLengthFixture.partialBody
        )
        XCTAssertEqual(RewriteFraming.classifyHTTPRequest(in: complete), .complete(length: complete.count))
        XCTAssertEqual(RewriteFraming.classifyHTTPRequest(in: partial), .incomplete)
        XCTAssertEqual(
            RewriteFraming.classifyHTTPRequest(in: Data(HTTPContentLengthFixture.requestLine.utf8)), .incomplete
        )
        let bodyless = HTTPContentLengthFixture.request(lengths: [])
        XCTAssertEqual(RewriteFraming.classifyHTTPRequest(in: bodyless), .complete(length: bodyless.count))
    }

    func testLowercaseHeaderAndTrimmedValueAreHandled() {
        let request = HTTPContentLengthFixture.request(
            lengths: [HTTPContentLengthFixture.paddedValidLength],
            body: HTTPContentLengthFixture.body,
            headerName: HTTPContentLengthFixture.lowercaseHeaderName
        )
        XCTAssertEqual(RewriteFraming.classifyHTTPRequest(in: request), .complete(length: request.count))
    }

    func testMalformedLengthsSend400AndStopReceiving() throws {
        for length in HTTPContentLengthFixture.invalidValues {
            try assertRejectedConnection(length: length, statusLine: HTTPContentLengthFixture.badRequestStatusLine)
        }
    }

    func testOverLimitLengthSends413AndStopsReceiving() throws {
        for length in HTTPContentLengthFixture.oversizedValues {
            try assertRejectedConnection(length: length, statusLine: HTTPContentLengthFixture.payloadTooLargeStatusLine)
        }
    }

    func testValidPostStillInvokesBatchHook() throws {
        defer { _ = SdkEventBuffer.shared.drain() }
        let request = HTTPContentLengthFixture.request(
            lengths: [HTTPContentLengthFixture.validLength], body: HTTPContentLengthFixture.body
        )
        let (recorder, channel) = runConnection(request)
        XCTAssertEqual(recorder.messages, [HTTPContentLengthFixture.body])
        XCTAssertEqual(recorder.sends.count, 1)
        let responseData = try XCTUnwrap(recorder.sends.first)
        let response = try XCTUnwrap(String(data: responseData, encoding: .utf8))
        XCTAssertTrue(response.hasPrefix(HTTPContentLengthFixture.okStatusLine))
        XCTAssertEqual(channel.receiveCount, 1)
        XCTAssertEqual(channel.cancelCount, 1)
        XCTAssertEqual(recorder.closes, 1)
    }

    func testPartialPostWaitsWithoutSendingOrCallingBatchHook() {
        let request = HTTPContentLengthFixture.request(
            lengths: [HTTPContentLengthFixture.validLength], body: HTTPContentLengthFixture.partialBody
        )
        let (recorder, channel) = runConnection(request)
        XCTAssertTrue(recorder.sends.isEmpty)
        XCTAssertTrue(recorder.messages.isEmpty)
        XCTAssertEqual(channel.receiveCount, 2)
        XCTAssertEqual(channel.cancelCount, 0)
        XCTAssertEqual(recorder.closes, 0)
    }

    private func assertRejectedConnection(length: String, statusLine: String) throws {
        let (recorder, channel) = runConnection(HTTPContentLengthFixture.request(lengths: [length]))
        XCTAssertEqual(recorder.sends.count, 1)
        let responseData = try XCTUnwrap(recorder.sends.first)
        let response = try XCTUnwrap(String(data: responseData, encoding: .utf8))
        XCTAssertEqual(response, statusLine + HTTPContentLengthFixture.closeResponseHeaders)
        XCTAssertTrue(response.contains(HTTPContentLengthFixture.connectionCloseHeader))
        XCTAssertEqual(channel.receiveCount, 1)
        XCTAssertEqual(channel.cancelCount, 1)
        XCTAssertEqual(recorder.closes, 1)
        XCTAssertTrue(recorder.messages.isEmpty)
        XCTAssertEqual(recorder.upgrades, 0)
    }

    private func runConnection(_ request: Data) -> (ConnectionRecorder, ContentLengthRequestByteChannel) {
        let queue = DispatchQueue(label: HTTPContentLengthFixture.queueLabel)
        let recorder = ConnectionRecorder()
        let channel = ContentLengthRequestByteChannel(request: request, recorder: recorder)
        let connection = WebSocketConnection(
            id: HTTPContentLengthFixture.connectionId,
            channel: channel,
            queue: queue,
            boundPort: HTTPContentLengthFixture.boundPort,
            onSdkEventBatch: { recorder.messages.append($0) },
            onUpgrade: { recorder.upgrades += 1 },
            onMessage: { _ in },
            onClose: { recorder.closes += 1 }
        )
        connection.start()
        queue.sync {}
        withExtendedLifetime(connection) {}
        return (recorder, channel)
    }
}

private enum HTTPContentLengthFixture {
    static let requestLine = "POST /sdk-events HTTP/1.1\r\n"
    static let headerSeparator = "\r\n\r\n"
    static let headerName = "Content-Length"
    static let lowercaseHeaderName = "content-length"
    static let headerValueSeparator = ": "
    static let lineSeparator = "\r\n"
    static let negativeLength = "-1"
    static let invalidValues = [negativeLength, "abc", "+5", "", "1.5", "5 5", "٥", "５"]
    static let overflowingLength = String(Int.max) + "0"
    static let oversizedValues = ["2000000", overflowingLength]
    static let validLength = "5"
    static let paddedValidLength = " \t5\t "
    static let secondValidLength = "6"
    static let boundaryLengthTemplate = "999999"
    static let body = Data("hello".utf8)
    static let partialBody = Data("hel".utf8)
    static let invalidUTF8Byte: UInt8 = 0xFF
    static let badRequestStatusLine = "HTTP/1.1 400 Bad Request\r\n"
    static let payloadTooLargeStatusLine = "HTTP/1.1 413 Payload Too Large\r\n"
    static let okStatusLine = "HTTP/1.1 200 OK\r\n"
    static let connectionCloseHeader = "Connection: close\r\n"
    static let closeResponseHeaders = "Content-Length: 0\r\nConnection: close\r\n\r\n"
    static let queueLabel = "content-length-http.test.connection"
    static let connectionId = 1
    static let boundPort: UInt16 = 8765

    static func request(
        lengths: [String], body: Data = Data(), headerName: String = HTTPContentLengthFixture.headerName
    )
        -> Data
    {
        let headers = lengths.map { headerName + headerValueSeparator + $0 + lineSeparator }.joined()
        return Data((requestLine + headers + lineSeparator).utf8) + body
    }
}

/// Like the unmatched-request fake, cancellation notifies state synchronously so
/// the queue barrier observes the close callback without sockets or waits.
private final class ContentLengthRequestByteChannel: ByteChannel, @unchecked Sendable {
    var onState: (@Sendable (ByteChannelState) -> Void)?
    private var request: Data?
    private let recorder: ConnectionRecorder
    private(set) var receiveCount = 0
    private(set) var cancelCount = 0

    init(request: Data, recorder: ConnectionRecorder) {
        self.request = request
        self.recorder = recorder
    }

    func start(queue: DispatchQueue) {
        queue.async { [weak self] in self?.onState?(.ready) }
    }

    func receive(
        minimumIncompleteLength _: Int,
        maximumLength _: Int,
        completion: @escaping @Sendable (Data?, Bool, Error?) -> Void
    ) {
        receiveCount += 1
        guard let request else { return }
        self.request = nil
        completion(request, false, nil)
    }

    func send(_ data: Data, completion: @escaping @Sendable (Error?) -> Void) {
        recorder.sends.append(data)
        completion(nil)
    }

    func cancel() {
        cancelCount += 1
        onState?(.cancelled)
    }
}
