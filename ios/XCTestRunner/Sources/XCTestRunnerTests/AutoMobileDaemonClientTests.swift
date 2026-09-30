import Foundation
import XCTest
@testable import XCTestRunner

final class AutoMobileDaemonClientTests: XCTestCase {
    func testSkipsNonMatchingFrameUntilMatchingReply() throws {
        let connection = FakeDaemonLineConnection(receives: [
            .line(#"{"type":"daemon_notification","method":"changed"}"#),
            .line(response(id: "1")),
        ])
        let factory = FakeDaemonLineConnectionFactory(connections: [connection])
        let client = AutoMobileDaemonClient(socketPath: "/unused", connectionFactory: factory)

        let result = try client.callTool(name: "observe", arguments: [:], timeout: 1)

        XCTAssertEqual(result.text, "ok")
        XCTAssertEqual(factory.connectCount, 1)
        XCTAssertEqual(connection.receiveCount, 2)
    }

    func testReceiveFailureDropsConnectionAndNextRequestReconnects() throws {
        let failedConnection = FakeDaemonLineConnection(receives: [.failure])
        let recoveredConnection = FakeDaemonLineConnection(receives: [.line(response(id: "2"))])
        let factory = FakeDaemonLineConnectionFactory(connections: [failedConnection, recoveredConnection])
        let client = AutoMobileDaemonClient(socketPath: "/unused", connectionFactory: factory)

        XCTAssertThrowsError(try client.callTool(name: "observe", arguments: [:], timeout: 1))
        XCTAssertTrue(failedConnection.wasCancelled)

        let result = try client.callTool(name: "observe", arguments: [:], timeout: 1)

        XCTAssertEqual(result.text, "ok")
        XCTAssertEqual(factory.connectCount, 2)
        XCTAssertTrue(recoveredConnection.wasConnected)
    }

    private func response(id: String) -> String {
        #"{"id":"\#(id)","type":"mcp_response","success":true,"result":{"content":[{"type":"text","text":"ok"}]}}"#
    }
}

private enum FakeReceive {
    case line(String)
    case failure
}

private enum FakeConnectionError: Error {
    case closed
}

private final class FakeDaemonLineConnectionFactory: DaemonLineConnectionFactory {
    private var connections: [FakeDaemonLineConnection]
    private(set) var connectCount = 0

    init(connections: [FakeDaemonLineConnection]) { self.connections = connections }

    func makeConnection(socketPath _: String) -> DaemonLineConnection {
        connectCount += 1
        return connections.removeFirst()
    }
}

private final class FakeDaemonLineConnection: DaemonLineConnection {
    private var receives: [FakeReceive]
    private(set) var wasConnected = false
    private(set) var wasCancelled = false
    private(set) var receiveCount = 0

    init(receives: [FakeReceive]) { self.receives = receives }

    func connect(timeout _: TimeInterval) throws { wasConnected = true }
    func sendLine(_: Data, timeout _: TimeInterval) throws {}
    func receiveLine(timeout _: TimeInterval) throws -> Data {
        receiveCount += 1
        switch receives.removeFirst() {
        case let .line(line): return Data(line.utf8)
        case .failure: throw FakeConnectionError.closed
        }
    }

    func cancel() { wasCancelled = true }
}
