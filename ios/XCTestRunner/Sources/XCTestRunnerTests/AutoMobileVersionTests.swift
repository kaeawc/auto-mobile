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

    func testResolveRepoRootDaemonEntryScript() throws {
        XCTAssertNil(DaemonManager.resolveRepoRootDaemonEntryScript(nil))
        XCTAssertNil(DaemonManager.resolveRepoRootDaemonEntryScript(""))

        let repoRoot = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("automobile-reporoot-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: repoRoot, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: repoRoot) }

        // No built entrypoint yet -> nil.
        XCTAssertNil(DaemonManager.resolveRepoRootDaemonEntryScript(repoRoot.path))

        let distDir = repoRoot.appendingPathComponent("dist/src")
        try FileManager.default.createDirectory(at: distDir, withIntermediateDirectories: true)
        let entry = distDir.appendingPathComponent("index.js")
        try "// entry".write(to: entry, atomically: true, encoding: .utf8)

        XCTAssertEqual(DaemonManager.resolveRepoRootDaemonEntryScript(repoRoot.path), entry.path)
    }

    func testRequiresRepoRootBuildSkew() throws {
        // No repoRoot build -> never a skew, regardless of the daemon's entry script.
        XCTAssertFalse(DaemonManager.requiresRepoRootBuildSkew(
            daemonEntryScript: "/x/dist/src/index.js",
            repoRoot: nil
        ))

        let repoRoot = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("automobile-rrskew-\(UUID().uuidString)")
        let distDir = repoRoot.appendingPathComponent("dist/src")
        try FileManager.default.createDirectory(at: distDir, withIntermediateDirectories: true)
        let entry = distDir.appendingPathComponent("index.js")
        try "// entry".write(to: entry, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: repoRoot) }

        // Daemon started from a different checkout's entry script -> skew.
        XCTAssertTrue(DaemonManager.requiresRepoRootBuildSkew(
            daemonEntryScript: "/other/dist/src/index.js", repoRoot: repoRoot.path
        ))
        // Daemon started from this repoRoot's entry script -> no skew.
        XCTAssertFalse(DaemonManager.requiresRepoRootBuildSkew(
            daemonEntryScript: entry.path, repoRoot: repoRoot.path
        ))
        // Daemon records no entry script -> cannot prove skew.
        XCTAssertFalse(DaemonManager.requiresRepoRootBuildSkew(daemonEntryScript: nil, repoRoot: repoRoot.path))
    }
}
