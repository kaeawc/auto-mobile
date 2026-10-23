import Foundation
import XCTest
@testable import XCTestRunner

final class DaemonHTTPPortDiscoveryTests: XCTestCase {
    private func discovery(
        _ contents: String?,
        environment: [String: String] = [:],
        paths: PathRecorder = PathRecorder(),
        logger: TokenDiscoveryLogger = TokenDiscoveryLogger()
    )
        -> DaemonPidFilePortDiscovery
    {
        DaemonPidFilePortDiscovery(
            environment: { environment }, currentDirectory: { "/work/lane" }, userId: { 501 },
            readFile: { paths.record($0); return contents.map { Data($0.utf8) } }, logger: logger
        )
    }

    final class PathRecorder: @unchecked Sendable {
        private let lock = NSLock()
        private var recorded: [String] = []
        var paths: [String] { lock.lock(); defer { lock.unlock() }; return recorded }
        func record(_ path: String) { lock.lock(); recorded.append(path); lock.unlock() }
    }

    func testReadsPortFromDefaultPidFile() {
        let paths = PathRecorder()
        XCTAssertEqual(discovery(#"{"pid":7,"port":3161}"#, paths: paths).discoveredPort(), 3161)
        XCTAssertEqual(paths.paths, ["/tmp/auto-mobile-daemon-501.pid"])
    }

    func testUsesIsolatedPidFileOverride() {
        let paths = PathRecorder()
        XCTAssertEqual(
            discovery(
                #"{"pid":7,"port":4000}"#,
                environment: ["AUTOMOBILE_DAEMON_PID_FILE_PATH": "state/daemon.pid"], paths: paths
            ).discoveredPort(), 4000
        )
        XCTAssertEqual(paths.paths, ["/work/lane/state/daemon.pid"])
    }

    func testMissingUnreadableOrPortlessPidFileIsUnverifiableAndLogsFixedMessage() {
        for contents in [nil, "not json", #"{"pid":7}"#] {
            let logger = TokenDiscoveryLogger()
            XCTAssertNil(discovery(contents, logger: logger).discoveredPort())
            XCTAssertEqual(logger.messages, ["Daemon HTTP port unavailable"])
        }
    }
}
