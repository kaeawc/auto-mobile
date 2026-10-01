import XCTest
@testable import XCTestRunner

final class DaemonReadinessTests: XCTestCase {
    func testWaitForDaemonRequiresSuccessfulSocketConnect() {
        let connector = FakeDaemonSocketConnector(results: [false, false, true])
        var time = Date(timeIntervalSince1970: 0)

        let ready = DaemonManager.waitForDaemon(
            timeoutSeconds: 1,
            isDaemonRunning: { true },
            socketExists: { true },
            socketPath: "/fake/daemon.sock",
            connector: connector,
            now: { time },
            sleep: { time.addTimeInterval($0) }
        )

        XCTAssertTrue(ready)
        XCTAssertEqual(connector.probedPaths, ["/fake/daemon.sock", "/fake/daemon.sock", "/fake/daemon.sock"])
    }

    func testWaitForDaemonTimesOutWhenSocketConnectFails() {
        let connector = FakeDaemonSocketConnector(results: [false, false, false])
        var time = Date(timeIntervalSince1970: 0)

        let ready = DaemonManager.waitForDaemon(
            timeoutSeconds: 0.5,
            isDaemonRunning: { true },
            socketExists: { true },
            socketPath: "/stale/daemon.sock",
            connector: connector,
            now: { time },
            sleep: { time.addTimeInterval($0) }
        )

        XCTAssertFalse(ready)
        XCTAssertEqual(connector.probedPaths.count, 3)
    }
}

private final class FakeDaemonSocketConnector: DaemonSocketConnector {
    private var results: [Bool]
    private(set) var probedPaths: [String] = []

    init(results: [Bool]) { self.results = results }

    func connectAndClose(socketPath: String, timeout _: TimeInterval) -> Bool {
        probedPaths.append(socketPath)
        return results.isEmpty ? false : results.removeFirst()
    }
}
