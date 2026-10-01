@testable import CtrlProxyRewrite
import Foundation
import XCTest

final class UnmatchedHTTPRequestTests: XCTestCase {
    func testUnmatchedRequestSends404CancelsAndRemovesRegistryEntry() {
        let queue = DispatchQueue(label: "unmatched-http.test.connection")
        let channel = UnmatchedRequestByteChannel(request: Data("GET / HTTP/1.1\r\nHost: x\r\n\r\n".utf8))
        let registry = ConnectionRegistry<WebSocketConnection>()
        let connection = WebSocketConnection(
            id: 42,
            channel: channel,
            queue: queue,
            boundPort: 8765,
            onMessage: { _ in },
            onClose: { registry.removeValue(forId: 42) }
        )
        registry.set(connection, forId: 42)

        connection.start()
        queue.sync {}

        XCTAssertEqual(channel.sends.count, 1)
        let response = String(decoding: channel.sends[0], as: UTF8.self)
        XCTAssertTrue(response.hasPrefix("HTTP/1.1 404 Not Found\r\n"))
        XCTAssertTrue(response.contains("Content-Length: 0\r\n"))
        XCTAssertTrue(response.contains("Connection: close\r\n"))
        XCTAssertEqual(channel.cancelCount, 1)
        XCTAssertEqual(channel.receiveCount, 1, "the HTTP receive loop must not be re-armed")
        XCTAssertEqual(channel.closeCount, 1)
        XCTAssertTrue(registry.isEmpty, "onClose must remove the connection from its registry")
    }

    func testHealthCheckStillUsesRecognizedRoute() {
        let recorder = RewriteConnectionDriver.run(
            inbound: Data("GET /health HTTP/1.1\r\nHost: x\r\n\r\n".utf8)
        )

        XCTAssertEqual(recorder.sends.count, 1)
        XCTAssertTrue(String(decoding: recorder.sends[0], as: UTF8.self).contains("HTTP/1.1 200 OK"))
    }
}

private final class UnmatchedRequestByteChannel: ByteChannel, @unchecked Sendable {
    var onState: (@Sendable (ByteChannelState) -> Void)?
    private let request: Data
    private var didReceive = false
    private var queue: DispatchQueue?
    private(set) var sends: [Data] = []
    private(set) var receiveCount = 0
    private(set) var cancelCount = 0
    private(set) var closeCount = 0

    init(request: Data) {
        self.request = request
    }

    func start(queue: DispatchQueue) {
        self.queue = queue
        queue.async { [weak self] in self?.onState?(.ready) }
    }

    func receive(
        minimumIncompleteLength _: Int,
        maximumLength _: Int,
        completion: @escaping @Sendable (Data?, Bool, Error?) -> Void
    ) {
        receiveCount += 1
        guard !didReceive else {
            completion(nil, false, nil)
            return
        }
        didReceive = true
        completion(request, false, nil)
    }

    func send(_ data: Data, completion: @escaping @Sendable (Error?) -> Void) {
        sends.append(data)
        completion(nil)
    }

    func cancel() {
        cancelCount += 1
        closeCount += 1
        onState?(.cancelled)
    }
}
