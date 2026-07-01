import XCTest
@testable import XCTestRunner

final class AutoMobileVersionTests: XCTestCase {
    func testCurrentVersionIsNonEmptySemver() {
        let version = AutoMobileVersion.current
        XCTAssertFalse(version.isEmpty, "baked client version must not be empty")

        // MAJOR.MINOR.PATCH release portion the daemon handshake compares against.
        let components = version.split(separator: "+").first.map(String.init) ?? version
        let parts = components.split(separator: ".")
        XCTAssertEqual(parts.count, 3, "version should be MAJOR.MINOR.PATCH, got \(version)")
        for part in parts {
            XCTAssertNotNil(Int(part), "version component \(part) should be numeric in \(version)")
        }
    }

    func testReleaseVersionStripsGitStamp() {
        XCTAssertEqual(DaemonManager.releaseVersion("0.0.40+gabc123"), "0.0.40")
        XCTAssertEqual(DaemonManager.releaseVersion("0.0.40"), "0.0.40")
        XCTAssertEqual(DaemonManager.releaseVersion(""), "")
    }

    func testRequiresVersionSkewRestartWhenReleasesDiffer() {
        XCTAssertTrue(DaemonManager.requiresVersionSkewRestart(daemonVersion: "0.0.41", clientVersion: "0.0.40"))
        XCTAssertTrue(DaemonManager.requiresVersionSkewRestart(daemonVersion: "0.0.39", clientVersion: "0.0.40"))
    }

    func testNoSkewRestartWhenReleasesMatch() {
        XCTAssertFalse(DaemonManager.requiresVersionSkewRestart(daemonVersion: "0.0.40", clientVersion: "0.0.40"))
        // Source-checkout daemon carries a git stamp; runner declares the plain release.
        XCTAssertFalse(DaemonManager.requiresVersionSkewRestart(
            daemonVersion: "0.0.40+gabc123",
            clientVersion: "0.0.40"
        ))
    }

    func testNoSkewRestartWhenEitherSideUnknown() {
        XCTAssertFalse(DaemonManager.requiresVersionSkewRestart(daemonVersion: nil, clientVersion: "0.0.40"))
        XCTAssertFalse(DaemonManager.requiresVersionSkewRestart(daemonVersion: "  ", clientVersion: "0.0.40"))
        XCTAssertFalse(DaemonManager.requiresVersionSkewRestart(daemonVersion: "0.0.40", clientVersion: ""))
    }
}
