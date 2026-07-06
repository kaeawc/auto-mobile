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

    func testRequiresAssetVersionPinFailureOnlyForExplicitMismatchedPins() {
        XCTAssertTrue(DaemonManager.requiresAssetVersionPinFailure(
            daemonAssetVersion: "0.0.18",
            callerPinnedVersion: "0.0.39"
        ))
        XCTAssertFalse(DaemonManager.requiresAssetVersionPinFailure(
            daemonAssetVersion: "0.0.18",
            callerPinnedVersion: "0.0.18"
        ))
        XCTAssertFalse(DaemonManager.requiresAssetVersionPinFailure(
            daemonAssetVersion: "0.0.18",
            callerPinnedVersion: nil
        ))
        XCTAssertFalse(DaemonManager.requiresAssetVersionPinFailure(
            daemonAssetVersion: "0.0.18",
            callerPinnedVersion: ""
        ))
        XCTAssertFalse(DaemonManager.requiresAssetVersionPinFailure(
            daemonAssetVersion: "0.0.18",
            callerPinnedVersion: "latest"
        ))
        XCTAssertTrue(DaemonManager.requiresAssetVersionPinFailure(
            daemonAssetVersion: nil,
            callerPinnedVersion: "0.0.18"
        ))
        XCTAssertTrue(DaemonManager.requiresAssetVersionPinFailure(
            daemonAssetVersion: "",
            callerPinnedVersion: "0.0.18"
        ))
        XCTAssertTrue(DaemonManager.requiresAssetVersionPinFailure(
            daemonAssetVersion: "  ",
            callerPinnedVersion: "0.0.18"
        ))
    }

    func testRequiresImmediateAssetVersionPinFailurePreservesRestartableSkewPaths() {
        XCTAssertTrue(DaemonManager.requiresImmediateAssetVersionPinFailure(
            assetVersionSkew: true,
            versionSkew: false,
            buildSkew: false
        ))
        XCTAssertFalse(DaemonManager.requiresImmediateAssetVersionPinFailure(
            assetVersionSkew: true,
            versionSkew: true,
            buildSkew: false
        ))
        XCTAssertFalse(DaemonManager.requiresImmediateAssetVersionPinFailure(
            assetVersionSkew: true,
            versionSkew: false,
            buildSkew: true
        ))
        XCTAssertFalse(DaemonManager.requiresImmediateAssetVersionPinFailure(
            assetVersionSkew: false,
            versionSkew: false,
            buildSkew: false
        ))
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
        // No repoRoot build -> never a skew, regardless of the daemon's identity.
        XCTAssertFalse(DaemonManager.requiresRepoRootBuildSkew(
            daemonBuildId: nil, daemonEntryScript: "/x/dist/src/index.js", repoRoot: nil
        ))

        let repoRoot = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("automobile-rrskew-\(UUID().uuidString)")
        let distDir = repoRoot.appendingPathComponent("dist/src")
        try FileManager.default.createDirectory(at: distDir, withIntermediateDirectories: true)
        let entry = distDir.appendingPathComponent("index.js")
        try "// entry".write(to: entry, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: repoRoot) }

        let matchingHash = try XCTUnwrap(DaemonManager.computeBuildId(entry.path))

        // Content hash takes precedence: a different build id is a skew even when the entry-script
        // path matches (the same repoRoot path rebuilt to another commit).
        XCTAssertTrue(DaemonManager.requiresRepoRootBuildSkew(
            daemonBuildId: "deadbeefdeadbeef", daemonEntryScript: entry.path, repoRoot: repoRoot.path
        ))
        // Matching build id -> no skew.
        XCTAssertFalse(DaemonManager.requiresRepoRootBuildSkew(
            daemonBuildId: matchingHash, daemonEntryScript: entry.path, repoRoot: repoRoot.path
        ))
        // No build id -> fall back to entry-script path: different path is a skew.
        XCTAssertTrue(DaemonManager.requiresRepoRootBuildSkew(
            daemonBuildId: nil, daemonEntryScript: "/other/dist/src/index.js", repoRoot: repoRoot.path
        ))
        // No build id, matching path -> no skew.
        XCTAssertFalse(DaemonManager.requiresRepoRootBuildSkew(
            daemonBuildId: nil, daemonEntryScript: entry.path, repoRoot: repoRoot.path
        ))
        // No build id and no entry script -> cannot prove skew.
        XCTAssertFalse(DaemonManager.requiresRepoRootBuildSkew(
            daemonBuildId: nil, daemonEntryScript: nil, repoRoot: repoRoot.path
        ))
    }
}
