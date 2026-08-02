import XCTest
@testable import XCTestRunner

final class AutoMobileVersionTests: XCTestCase {
    /// AC #2814: the built runner reports the version of the release it was cut from.
    /// package.json is the canonical source; the constant is generated from it, so this
    /// pins that the baked value has not drifted. Resolved via `#filePath` so it is
    /// independent of the test's working directory.
    func testCurrentVersionMatchesCanonicalPackageJson() throws {
        // .../ios/XCTestRunner/Sources/XCTestRunnerTests/AutoMobileVersionTests.swift
        //  -> repo root is five directories up from this source file.
        var repoRoot = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 {
            repoRoot.deleteLastPathComponent()
        }
        let packageJsonURL = repoRoot.appendingPathComponent("package.json")

        let data = try Data(contentsOf: packageJsonURL)
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        let packageVersion = try XCTUnwrap(json?["version"] as? String,
                                           "package.json must have a string version field")

        XCTAssertEqual(
            AutoMobileVersion.current,
            packageVersion,
            "baked runner version must match canonical package.json; regenerate with "
                + "scripts/versioning/generate-ios-version.sh"
        )
    }

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

    func testPinnedDaemonPackageCommandUsesBunxAndAutomobileVersion() throws {
        let command = try XCTUnwrap(DaemonManager.buildPackageDaemonCommand(
            packageRunner: "/opt/homebrew/bin/bunx",
            subcommand: "start",
            packageVersion: "0.0.40"
        ))

        XCTAssertEqual(command, [
            "@kaeawc/auto-mobile@0.0.40",
            "--daemon",
            "start",
        ])
    }

    func testPinnedDaemonPackageCommandUsesNpxNonInteractiveFlag() throws {
        let command = try XCTUnwrap(DaemonManager.buildPackageDaemonCommand(
            packageRunner: "/usr/local/bin/npx",
            subcommand: "restart",
            packageVersion: "0.0.40"
        ))

        XCTAssertEqual(command, [
            "-y",
            "@kaeawc/auto-mobile@0.0.40",
            "--daemon",
            "restart",
        ])
    }

    func testResolveDaemonPackageVersionPrefersExplicitPinThenAutomobileVersion() {
        XCTAssertEqual(DaemonManager.resolveDaemonPackageVersion(environment: [
            "AUTOMOBILE_DAEMON_PACKAGE_VERSION": " 0.0.41 ",
            "AUTOMOBILE_VERSION": "0.0.40",
        ]), "0.0.41")
        XCTAssertEqual(DaemonManager.resolveDaemonPackageVersion(environment: [
            "AUTOMOBILE_VERSION": " 0.0.40 ",
        ]), "0.0.40")
        XCTAssertNil(DaemonManager.resolveDaemonPackageVersion(environment: [:]))
    }

    func testPinnedDaemonPackageCommandRejectsFloatingOrUnknownPins() {
        for packageVersion in ["latest", "unknown", "next", "0.0.x", "^0.0.40", "~0.0.40", ">=0.0.40"] {
            XCTAssertNil(DaemonManager.buildPackageDaemonCommand(
                packageRunner: "/opt/homebrew/bin/bunx",
                subcommand: "start",
                packageVersion: packageVersion
            ), "\(packageVersion) must not be accepted as a hermetic package pin")
        }
        XCTAssertNotNil(DaemonManager.buildPackageDaemonCommand(
            packageRunner: "/opt/homebrew/bin/bunx",
            subcommand: "start",
            packageVersion: "0.0.40-rc.1"
        ))
    }

    func testDaemonLaunchSelectsPinnedPackageInsteadOfPathExecutable() {
        XCTAssertEqual(DaemonManager.selectDaemonLaunch(
            subcommand: "start",
            localEntry: nil,
            runtime: nil,
            packageRunner: "/opt/homebrew/bin/bunx",
            autoMobilePath: "/usr/local/bin/auto-mobile",
            packageVersion: "0.0.40"
        ), .process(
            executable: "/opt/homebrew/bin/bunx",
            arguments: ["@kaeawc/auto-mobile@0.0.40", "--daemon", "start"]
        ))
    }

    func testDaemonLaunchRejectsPinnedStartWithoutPackageRunner() {
        XCTAssertEqual(DaemonManager.selectDaemonLaunch(
            subcommand: "start",
            localEntry: nil,
            runtime: nil,
            packageRunner: nil,
            autoMobilePath: "/usr/local/bin/auto-mobile",
            packageVersion: "0.0.40"
        ), .packageRunnerNotFound)
    }

    func testStartupFailureNamesMissingPackageRunnerAndLaunchTimeout() {
        XCTAssertEqual(
            DaemonManager.startupFailure(for: .packageRunnerNotFound),
            .packageRunnerNotFound
        )
        XCTAssertEqual(
            DaemonManager.startupFailure(for: .timedOut),
            .launchTimeout
        )
        XCTAssertTrue(DaemonStartupResult.packageRunnerNotFound.diagnosticMessage.contains("bunx"))
        XCTAssertTrue(DaemonStartupResult.packageRunnerNotFound.diagnosticMessage.contains("npx"))
        XCTAssertTrue(DaemonStartupResult.launchTimeout.diagnosticMessage.contains("timed out"))
        XCTAssertEqual(
            DaemonManager.startupFailure(for: DaemonManager.classifyDaemonSubcommandOutcome(
                .failed(stderr: "npm ERR! 404 package missing"),
                packageRunner: true
            )),
            .packageLaunchFailed(stderr: "npm ERR! 404 package missing")
        )
        XCTAssertEqual(
            DaemonManager.startupFailure(for: DaemonManager.classifyDaemonSubcommandOutcome(
                .failed(stderr: "bun failed"),
                packageRunner: false
            )),
            .launchFailed
        )
        XCTAssertTrue(DaemonStartupResult.packageLaunchFailed(
            stderr: "npm ERR! 404 package missing"
        ).diagnosticMessage.contains("404"))
    }

    func testDaemonLaunchPassesTimeoutToInjectedLauncher() {
        let launcher = FakeDaemonSubcommandLauncher(result: .timedOut)

        XCTAssertEqual(DaemonManager.executeDaemonLaunch(
            executable: "/usr/bin/env",
            arguments: ["auto-mobile", "--daemon", "start"],
            environment: ["PATH": "/usr/bin"],
            timeoutSeconds: 15,
            launcher: launcher
        ), .timedOut)
        XCTAssertEqual(launcher.invocations, [
            .init(
                executable: "/usr/bin/env",
                arguments: ["auto-mobile", "--daemon", "start"],
                timeoutSeconds: 15
            ),
        ])
    }

    func testDaemonLaunchPreservesBuiltCheckoutPrecedenceOverPin() {
        XCTAssertEqual(DaemonManager.selectDaemonLaunch(
            subcommand: "restart",
            localEntry: "/repo/dist/src/index.js",
            runtime: "/opt/homebrew/bin/bun",
            packageRunner: "/opt/homebrew/bin/bunx",
            autoMobilePath: "/usr/local/bin/auto-mobile",
            packageVersion: "0.0.40"
        ), .process(
            executable: "/opt/homebrew/bin/bun",
            arguments: ["/repo/dist/src/index.js", "--daemon", "restart"]
        ))
    }

    func testResolveDaemonClientVersionUsesPinWithoutBuiltCheckout() {
        XCTAssertEqual(DaemonManager.resolveDaemonClientVersion(
            repoRootHasBuiltEntry: false,
            environment: ["AUTOMOBILE_VERSION": "0.0.40"]
        ), "0.0.40")
        XCTAssertEqual(DaemonManager.resolveDaemonClientVersion(
            repoRootHasBuiltEntry: true,
            environment: ["AUTOMOBILE_VERSION": "0.0.40"]
        ), AutoMobileVersion.current)
    }

    func testResolveDaemonClientVersionKeepsCheckoutIdentityForUnscopedClients() {
        XCTAssertEqual(DaemonManager.resolveDaemonClientVersion(
            repoRootHasBuiltEntry: true,
            environment: ["AUTOMOBILE_DAEMON_PACKAGE_VERSION": "0.0.40"]
        ), AutoMobileVersion.current)
    }

    func testResolveDaemonClientVersionHonorsConfiguredRepoRoot() throws {
        let repoRoot = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("automobile-configured-root-\(UUID().uuidString)")
        let entry = repoRoot.appendingPathComponent("dist/src/index.js")
        try FileManager.default.createDirectory(at: entry.deletingLastPathComponent(), withIntermediateDirectories: true)
        try "// fixture entry".write(to: entry, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: repoRoot) }

        XCTAssertEqual(DaemonManager.resolveDaemonClientVersion(
            environment: [
                "AUTOMOBILE_REPO_ROOT": repoRoot.path,
                "AUTOMOBILE_DAEMON_PACKAGE_VERSION": "0.0.40",
            ]
        ), AutoMobileVersion.current)
    }

    func testResolveDaemonRepoRootPrefersTheProvidedCheckout() {
        XCTAssertEqual(
            DaemonManager.resolveDaemonRepoRoot("/repo"),
            "/repo"
        )
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

    func testFindRepoRootFindsNearestPackageJsonAncestor() throws {
        let repoRoot = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("automobile-root-discovery-\(UUID().uuidString)")
        let sourceDirectory = repoRoot.appendingPathComponent("ios/XCTestRunner/Sources/XCTestRunner")
        try FileManager.default.createDirectory(at: sourceDirectory, withIntermediateDirectories: true)
        try #"{"name": "@kaeawc/auto-mobile"}"#.write(
            to: repoRoot.appendingPathComponent("package.json"),
            atomically: true,
            encoding: .utf8
        )
        defer { try? FileManager.default.removeItem(at: repoRoot) }

        XCTAssertEqual(
            DaemonManager.findRepoRoot(startingAt: sourceDirectory.appendingPathComponent("Runner.swift").path),
            repoRoot.path
        )
    }

    func testFindRepoRootSkipsHostPackageWithBuiltEntryScript() throws {
        let hostRoot = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("automobile-host-\(UUID().uuidString)")
        let runnerSourceDirectory = hostRoot.appendingPathComponent("vendor/XCTestRunner/Sources/XCTestRunner")
        try FileManager.default.createDirectory(at: runnerSourceDirectory, withIntermediateDirectories: true)
        try #"{"name": "host-project"}"#.write(
            to: hostRoot.appendingPathComponent("package.json"),
            atomically: true,
            encoding: .utf8
        )
        let hostEntry = hostRoot.appendingPathComponent("dist/src/index.js")
        try FileManager.default.createDirectory(at: hostEntry.deletingLastPathComponent(), withIntermediateDirectories: true)
        try "// unrelated host entry".write(to: hostEntry, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: hostRoot) }

        XCTAssertNil(DaemonManager.findRepoRoot(
            startingAt: runnerSourceDirectory.appendingPathComponent("Runner.swift").path
        ))
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
        // Matching build id and entry path -> no skew.
        XCTAssertFalse(DaemonManager.requiresRepoRootBuildSkew(
            daemonBuildId: matchingHash, daemonEntryScript: entry.path, repoRoot: repoRoot.path
        ))
        // The entry-file hash can match across checkouts while copied runtime assets differ, so
        // the daemon must still come from this checkout's expected entry path.
        XCTAssertTrue(DaemonManager.requiresRepoRootBuildSkew(
            daemonBuildId: matchingHash, daemonEntryScript: "/other/dist/src/index.js", repoRoot: repoRoot.path
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

    func testEnsureDaemonRunningRestartsSameReleaseDaemonFromDifferentCheckout() throws {
        let repoRoot = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("automobile-activation-\(UUID().uuidString)")
        let distDir = repoRoot.appendingPathComponent("dist/src")
        try FileManager.default.createDirectory(at: distDir, withIntermediateDirectories: true)
        let entry = distDir.appendingPathComponent("index.js")
        try "// current checkout".write(to: entry, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: repoRoot) }

        let currentBuildId = try XCTUnwrap(DaemonManager.computeBuildId(entry.path))
        let runtime = FakeDaemonRuntime(
            daemonVersion: AutoMobileVersion.current,
            daemonBuildId: "different-checkout",
            daemonEntryScript: "/other-checkout/dist/src/index.js",
            buildIdAfterRestart: currentBuildId
        )

        let result = DaemonManager.ensureDaemonRunningResult(
            repoRoot: repoRoot.path,
            timeoutSeconds: 0,
            runtime: runtime,
            callerAssetVersion: nil
        )

        XCTAssertEqual(result, .ready)
        XCTAssertEqual(runtime.subcommands, [.init(name: "restart", repoRoot: repoRoot.path)])
    }

    func testEnsureDaemonRunningUsesInferredRootForBuildSkew() throws {
        let repoRoot = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("automobile-inferred-root-\(UUID().uuidString)")
        let entry = repoRoot.appendingPathComponent("dist/src/index.js")
        try FileManager.default.createDirectory(at: entry.deletingLastPathComponent(), withIntermediateDirectories: true)
        try "// fixture entry".write(to: entry, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: repoRoot) }

        let currentBuildId = try XCTUnwrap(DaemonManager.computeBuildId(entry.path))
        let runtime = FakeDaemonRuntime(
            daemonVersion: AutoMobileVersion.current,
            daemonBuildId: "different-checkout",
            daemonEntryScript: "/other-checkout/dist/src/index.js",
            buildIdAfterRestart: currentBuildId
        )

        let result = DaemonManager.ensureDaemonRunningResult(
            repoRoot: nil,
            timeoutSeconds: 0,
            runtime: runtime,
            callerAssetVersion: nil,
            inferredRepoRoot: repoRoot.path
        )

        XCTAssertEqual(result, .ready)
        XCTAssertEqual(runtime.subcommands, [.init(name: "restart", repoRoot: repoRoot.path)])
    }

    func testDaemonLaunchEnvironmentIncludesSelectedRunnerDirectory() {
        let environment = DaemonManager.daemonLaunchEnvironment(
            executable: "/opt/homebrew/bin/npx",
            environment: ["PATH": "/usr/bin"]
        )

        XCTAssertEqual(environment["PATH"], "/opt/homebrew/bin:/usr/bin:/usr/local/bin")
    }

    func testRestartLauncherTimeoutIncludesDaemonLifecycleBudget() {
        XCTAssertEqual(DaemonManager.daemonLauncherTimeoutSeconds(
            subcommand: "restart",
            readinessTimeoutSeconds: 15,
            environment: [:]
        ), 36)
        XCTAssertEqual(DaemonManager.daemonLauncherTimeoutSeconds(
            subcommand: "restart",
            readinessTimeoutSeconds: 15,
            environment: ["AUTOMOBILE_DAEMON_STARTUP_TIMEOUT_MS": "30000"]
        ), 96)
        XCTAssertEqual(DaemonManager.daemonLauncherTimeoutSeconds(
            subcommand: "start",
            readinessTimeoutSeconds: 15,
            environment: ["AUTOMOBILE_DAEMON_STARTUP_TIMEOUT_MS": "30000"]
        ), 90)
        XCTAssertEqual(DaemonManager.daemonLauncherTimeoutSeconds(
            subcommand: "start",
            readinessTimeoutSeconds: 15,
            environment: [:]
        ), 30)
    }

    func testEnsureDaemonRunningAcceptsDaemonMatchingPinnedClientVersion() {
        let runtime = FakeDaemonRuntime(
            daemonVersion: "0.0.40",
            daemonBuildId: nil,
            daemonEntryScript: nil,
            buildIdAfterRestart: ""
        )

        let result = DaemonManager.ensureDaemonRunningResult(
            repoRoot: nil,
            timeoutSeconds: 0,
            runtime: runtime,
            callerAssetVersion: nil,
            clientVersion: "0.0.40"
        )

        XCTAssertEqual(result, .ready)
        XCTAssertTrue(runtime.subcommands.isEmpty)
    }
}

private final class FakeDaemonSubcommandLauncher: DaemonManager.DaemonSubcommandLauncher {
    struct Invocation: Equatable {
        let executable: String
        let arguments: [String]
        let timeoutSeconds: TimeInterval
    }

    private let result: DaemonManager.DaemonSubcommandOutcome
    private(set) var invocations: [Invocation] = []

    init(result: DaemonManager.DaemonSubcommandOutcome) {
        self.result = result
    }

    func launch(
        executable: String,
        arguments: [String],
        environment _: [String: String],
        timeoutSeconds: TimeInterval
    ) -> DaemonManager.DaemonSubcommandOutcome {
        invocations.append(.init(
            executable: executable,
            arguments: arguments,
            timeoutSeconds: timeoutSeconds
        ))
        return result
    }
}

private final class FakeDaemonRuntime: DaemonRuntime {
    struct Invocation: Equatable {
        let name: String
        let repoRoot: String?
    }

    private let daemonVersion: String?
    private var daemonBuildId: String?
    private var daemonEntryScript: String?
    private let buildIdAfterRestart: String
    private(set) var subcommands: [Invocation] = []

    init(
        daemonVersion: String?,
        daemonBuildId: String?,
        daemonEntryScript: String?,
        buildIdAfterRestart: String
    ) {
        self.daemonVersion = daemonVersion
        self.daemonBuildId = daemonBuildId
        self.daemonEntryScript = daemonEntryScript
        self.buildIdAfterRestart = buildIdAfterRestart
    }

    func isDaemonRunning() -> Bool {
        true
    }

    func readDaemonVersion() -> String? {
        daemonVersion
    }

    func readDaemonAssetVersion() -> String? {
        nil
    }

    func readDaemonEntryScript() -> String? {
        daemonEntryScript
    }

    func readDaemonBuildId() -> String? {
        daemonBuildId
    }

    func runDaemonSubcommand(
        _ subcommand: String,
        repoRoot: String?,
        timeoutSeconds _: TimeInterval
    )
        -> DaemonManager.DaemonSubcommandOutcome
    {
        subcommands.append(.init(name: subcommand, repoRoot: repoRoot))
        daemonBuildId = buildIdAfterRestart
        if let repoRoot = repoRoot {
            daemonEntryScript = URL(fileURLWithPath: repoRoot)
                .appendingPathComponent("dist/src/index.js").path
        }
        return .launched
    }

    func waitForDaemon(timeoutSeconds _: TimeInterval) -> Bool {
        true
    }
}
