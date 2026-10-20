import Darwin
import Foundation
import XCTest
@testable import XCTestRunner

final class DaemonHTTPTokenProviderTests: XCTestCase {
    private func provider(
        _ files: FakeDaemonTokenFileAccess,
        environment: [String: String] = [:],
        logger: TokenDiscoveryLogger = TokenDiscoveryLogger()
    )
        -> DaemonHTTPTokenProvider
    {
        DaemonHTTPTokenProvider(
            environment: { environment }, currentDirectory: { "/work/lane" }, userId: { 501 },
            files: files, logger: logger
        )
    }

    func testTrimmedEnvironmentTokenWinsWithoutFileAccess() {
        let files = FakeDaemonTokenFileAccess()
        let logger = TokenDiscoveryLogger()
        XCTAssertEqual(provider(files, environment: [
            "AUTOMOBILE_DAEMON_HTTP_TOKEN": " \tenv-token\n",
            "AUTOMOBILE_DAEMON_TOKEN_FILE_PATH": "/unused",
        ], logger: logger).readToken(), "env-token")
        XCTAssertTrue(files.calls.paths.isEmpty)
        XCTAssertTrue(logger.messages.isEmpty)
    }

    func testBlankEnvironmentFallsBackToTrimmedFileToken() {
        let files = FakeDaemonTokenFileAccess()
        let reader = provider(files, environment: ["AUTOMOBILE_DAEMON_HTTP_TOKEN": " \t\n"])
        XCTAssertEqual(reader.readToken(), "file-token")
        XCTAssertEqual(reader.readToken(), "file-token", "Every read reopens the file")
        XCTAssertEqual(files.calls.paths, Array(repeating: "/tmp/auto-mobile-daemon-501.token", count: 2))
        XCTAssertEqual(files.calls.flags, Array(repeating: O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC, count: 2))
        XCTAssertEqual(files.calls.inspected, [42, 42])
        XCTAssertEqual(files.calls.closed, [42, 42])
    }

    func testRelativeTokenOverrideResolvesAgainstLaunchDirectory() {
        let files = FakeDaemonTokenFileAccess()
        XCTAssertNotNil(provider(files, environment: [
            "AUTOMOBILE_DAEMON_TOKEN_FILE_PATH": " state/../daemon.token \n",
            "AUTOMOBILE_DAEMON_LAUNCH_CWD": " /launch/lane ",
            "AUTOMOBILE_AUX_SOCKET_DIR": "/unused/aux",
        ]).readToken())
        XCTAssertEqual(files.calls.paths, ["/launch/lane/daemon.token"])
    }

    func testRelativeTokenOverrideFallsBackToCurrentDirectory() {
        let files = FakeDaemonTokenFileAccess()
        XCTAssertNotNil(provider(files, environment: [
            "AUTOMOBILE_DAEMON_TOKEN_FILE_PATH": "./daemon.token",
            "AUTOMOBILE_DAEMON_LAUNCH_CWD": "relative/ignored",
        ]).readToken())
        XCTAssertEqual(files.calls.paths, ["/work/lane/daemon.token"])
    }

    func testMissingOrNonRegularPathIsNotOpened() {
        for metadata in [
            nil,
            FakeDaemonTokenFileAccess.regular(type: mode_t(S_IFLNK)),
            FakeDaemonTokenFileAccess.regular(type: mode_t(S_IFDIR)),
        ] {
            let files = FakeDaemonTokenFileAccess(pathMetadata: metadata)
            let logger = TokenDiscoveryLogger()
            XCTAssertNil(provider(files, logger: logger).readToken())
            XCTAssertTrue(files.calls.flags.isEmpty)
            XCTAssertTrue(files.calls.closed.isEmpty)
            XCTAssertEqual(logger.messages, ["Daemon HTTP token unavailable"])
        }
    }

    func testOpenFailureReturnsNoTokenAndDoesNotCloseInvalidDescriptor() {
        let files = FakeDaemonTokenFileAccess(descriptor: -1)
        XCTAssertNil(provider(files).readToken())
        XCTAssertTrue(files.calls.inspected.isEmpty)
        XCTAssertTrue(files.calls.closed.isEmpty)
    }

    func testOpenedInodeMustBeRegularOwnedByUidAndExactly0600() {
        let invalid: [stat?] = [
            nil,
            FakeDaemonTokenFileAccess.regular(type: mode_t(S_IFLNK)),
            FakeDaemonTokenFileAccess.regular(type: mode_t(S_IFIFO)),
            FakeDaemonTokenFileAccess.regular(uid: 502),
        ] + [0o000, 0o400, 0o640, 0o604, 0o660, 0o644, 0o1600, 0o4600].map {
            FakeDaemonTokenFileAccess.regular(mode: mode_t($0))
        }
        for metadata in invalid {
            let files = FakeDaemonTokenFileAccess(openedMetadata: metadata)
            XCTAssertNil(provider(files).readToken())
            XCTAssertTrue(files.calls.read.isEmpty)
            XCTAssertEqual(files.calls.closed, [42])
        }
    }

    func testReadFailureBlankOrInvalidUTF8ReturnsNoTokenAndClosesDescriptor() {
        for data in [nil, Data(), Data(" \t\n".utf8), Data([0xFF])] {
            let files = FakeDaemonTokenFileAccess(data: data)
            let logger = TokenDiscoveryLogger()
            XCTAssertNil(provider(files, logger: logger).readToken())
            XCTAssertEqual(files.calls.closed, [42])
            XCTAssertEqual(logger.messages, ["Daemon HTTP token unavailable"])
        }
    }

    func testNullInPathReturnsNoTokenWithoutFileAccess() {
        let files = FakeDaemonTokenFileAccess()
        XCTAssertNil(provider(files, environment: ["AUTOMOBILE_DAEMON_TOKEN_FILE_PATH": "/bad\0path"]).readToken())
        XCTAssertTrue(files.calls.paths.isEmpty)
    }
}
