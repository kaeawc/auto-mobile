@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeHTTP1CodecTests: XCTestCase {
    func testSerialization() throws {
        let request = pinnedRequest(
            "https://[2606:4700::1]:8443/a?q=1#secret",
            method: .post,
            headers: ["Z-Key": "z", "A-Key": "a"],
            body: .string("hi")
        )
        let bytes = try PrototypeHTTP1Codec.serialize(request, url: XCTUnwrap(URL(string: request.url)))
        XCTAssertEqual(
            String(data: bytes, encoding: .utf8),
            "POST /a?q=1 HTTP/1.1\r\nHost: [2606:4700::1]:8443\r\nA-Key: a\r\nContent-Type: text/plain; charset=utf-8\r\nZ-Key: z\r\nConnection: close\r\nAccept-Encoding: identity\r\nContent-Length: 2\r\n\r\nhi"
        )
        let plain = pinnedRequest()
        let text = try XCTUnwrap(String(
            data: PrototypeHTTP1Codec.serialize(plain, url: XCTUnwrap(URL(string: plain.url))),
            encoding: .utf8
        ))
        XCTAssertTrue(text.hasPrefix("GET / HTTP/1.1\r\nHost: public.example\r\n"))
    }

    func testTransportOwnsAcceptEncoding() throws {
        let request = pinnedRequest(headers: ["aCcEpT-EnCoDiNg": "gzip"])
        let bytes = try PrototypeHTTP1Codec.serialize(request, url: XCTUnwrap(URL(string: request.url)))
        let text = try XCTUnwrap(String(data: bytes, encoding: .utf8)).lowercased()
        XCTAssertEqual(text.components(separatedBy: "accept-encoding:").count, 2)
        XCTAssertFalse(text.contains("gzip"))
        XCTAssertTrue(text.contains("accept-encoding: identity\r\n"))
    }

    func testLengthAndRepeatedHeadersAndInterim() throws {
        let response =
            try parse(
                "HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nX-A: a\r\nX-A: b\r\nContent-Length: 3\r\n\r\nabc"
            )
        XCTAssertEqual(response.body, Data("abc".utf8))
        XCTAssertEqual(response.headers["x-a"], "a, b")
        XCTAssertEqual(response.status, 200)
    }

    func testChunkedExtensionsTrailersAndBytewiseSplits() throws {
        let text =
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3;key=value\r\nabc\r\n2\r\nde\r\n0\r\nX-Trailer: yes\r\n\r\n"
        var codec = PrototypeHTTP1Codec(method: .get, maxResponseBytes: 10)
        var response: PrototypeHTTP1Codec.Response?
        for byte in text.utf8 {
            response = try codec.append(Data([byte]))
        }
        XCTAssertEqual(response?.body, Data("abcde".utf8))
    }

    func testEOFAndBodylessResponses() throws {
        XCTAssertEqual(try parse("HTTP/1.1 200 OK\r\n\r\nabc", eof: true).body, Data("abc".utf8))
        for (method, status) in [(PrototypeRequestMethod.head, 200), (.get, 204), (.get, 304)] {
            var codec = PrototypeHTTP1Codec(method: method, maxResponseBytes: 1)
            let response = try codec.append(Data("HTTP/1.1 \(status) OK\r\nContent-Length: 9999\r\n\r\n".utf8))
            XCTAssertEqual(response?.body, Data())
        }
    }

    func testNonSuccessEndsAtHeaders() throws {
        var codec = PrototypeHTTP1Codec(method: .get, maxResponseBytes: 1)
        XCTAssertEqual(try codec.append(Data("HTTP/1.1 500 Error\r\nContent-Length: 9999\r\n\r\n".utf8))?.body, Data())
    }

    func testLimitsAndMalformedFraming() {
        assertFailure("HTTP/1.1 200 OK\r\nX: " + String(repeating: "x", count: 65536), .invalidResponse)
        assertFailure("HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n", .tooLarge)
        assertFailure("HTTP/1.1 200 OK\r\nContent-Length: 18446744073709551615\r\n\r\n", .tooLarge)
        assertFailure("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nB\r\n", .tooLarge)
        assertFailure("HTTP/1.1 200 OK\r\n\r\n12345678901", .tooLarge)
        assertFailure("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nZ\r\n", .invalidResponse)
        assertFailure("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\naXX", .invalidResponse)
        assertFailure("HTTP/1.1 200 OK\r\nContent-Length: -1\r\n\r\n", .invalidResponse)
        assertFailure("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\na", .invalidResponse, eof: true)
    }

    private func parse(_ text: String, eof: Bool = false) throws -> PrototypeHTTP1Codec.Response {
        var codec = PrototypeHTTP1Codec(method: .get, maxResponseBytes: 100)
        return try XCTUnwrap(codec.append(Data(text.utf8), eof: eof))
    }

    private func assertFailure(_ text: String, _ code: PrototypeRequestErrorCode, eof: Bool = false) {
        var codec = PrototypeHTTP1Codec(method: .get, maxResponseBytes: 10)
        XCTAssertThrowsError(try codec.append(Data(text.utf8), eof: eof)) {
            XCTAssertEqual(($0 as? PrototypeRequestError)?.code, code)
        }
    }
}
