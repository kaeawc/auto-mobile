import Darwin
import Foundation
import XCTest

// Phase-2b: the DaemonManager subsystem. Two kinds of lock:
//  1. A direct structural-JSON golden on the extracted `buildDaemonRequestLine` — the frozen P0
//     daemon-request wire envelope. (Compared structurally, NOT byte-for-byte: production
//     JSONSerialization emits unspecified key order.)
//  2. Differential parity (reference vs rewrite) for the pure version-skew and launch-resolution
//     logic. Custom-enum results are normalized to strings since same-named types in the two modules
//     are distinct and cannot be compared directly.
@testable import XCTestRunner
@testable import XCTestRunnerRewrite

final class Phase2DaemonParityTests: XCTestCase {
    // MARK: - P0 wire golden

    func testReleaseSessionRequestLineWireContract() throws {
        let line = try XCTUnwrap(XCTestRunnerRewrite.DaemonManager.buildDaemonRequestLine(
            id: "fixed-id",
            method: "daemon/releaseSession",
            params: ["sessionId": "sess-1"],
            clientVersion: "0.0.67"
        ))
        XCTAssertTrue(line.hasSuffix("\n"), "frozen framing: one JSON object terminated by \\n")
        let json = try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any]
        let object = try XCTUnwrap(json)
        XCTAssertEqual(Set(object.keys), ["id", "type", "method", "params", "clientVersion"])
        XCTAssertEqual(object["id"] as? String, "fixed-id")
        XCTAssertEqual(object["type"] as? String, "daemon_request")
        XCTAssertEqual(object["method"] as? String, "daemon/releaseSession")
        XCTAssertEqual(object["clientVersion"] as? String, "0.0.67")
        XCTAssertEqual((object["params"] as? [String: Any])?["sessionId"] as? String, "sess-1")
    }

    func testRefreshDevicesRequestLineWireContract() throws {
        let line = try XCTUnwrap(XCTestRunnerRewrite.DaemonManager.buildDaemonRequestLine(
            id: "fixed-id",
            method: "daemon/refreshDevices",
            params: [:],
            clientVersion: "0.0.67"
        ))
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any])
        XCTAssertEqual(object["type"] as? String, "daemon_request")
        XCTAssertEqual(object["method"] as? String, "daemon/refreshDevices")
        XCTAssertEqual((object["params"] as? [String: Any])?.isEmpty, true)
    }

    // MARK: - Socket path parity

    func testSocketAndPidPathParity() {
        XCTAssertEqual(XCTestRunner.DaemonManager.socketPath, XCTestRunnerRewrite.DaemonManager.socketPath)
        XCTAssertEqual(XCTestRunner.DaemonManager.pidFilePath, XCTestRunnerRewrite.DaemonManager.pidFilePath)
    }

    func testSetSocketPathBoundaryParity() {
        func referenceAccepts(_ path: String) -> Bool {
            var addr = sockaddr_un()
            return XCTestRunner.DaemonManager.setSocketPath(path, into: &addr)
        }
        func rewriteAccepts(_ path: String) -> Bool {
            var addr = sockaddr_un()
            return XCTestRunnerRewrite.DaemonManager.setSocketPath(path, into: &addr)
        }
        let capacity = MemoryLayout.size(ofValue: sockaddr_un().sun_path)
        let cases = [
            "/tmp/short.sock",
            String(repeating: "a", count: capacity - 1),   // just fits (with NUL)
            String(repeating: "a", count: capacity),        // no room for NUL → reject
            String(repeating: "a", count: capacity + 50),   // overlong → reject
        ]
        for path in cases {
            XCTAssertEqual(referenceAccepts(path), rewriteAccepts(path), "path length \(path.count)")
        }
    }

    // MARK: - Version-skew parity

    func testReleaseVersionParity() {
        for version in ["1.2.3", "1.2.3+g1a2b3c", "0.0.67", "1.0.0-beta.1+build.5", "", "+onlybuild"] {
            XCTAssertEqual(
                XCTestRunner.DaemonManager.releaseVersion(version),
                XCTestRunnerRewrite.DaemonManager.releaseVersion(version),
                "version=\(version)"
            )
        }
    }

    func testRequiresVersionSkewRestartParity() {
        let cases: [(String?, String)] = [
            (nil, "1.2.3"), ("", "1.2.3"), ("1.2.3", ""), ("1.2.3", "1.2.3"),
            ("1.2.3", "1.2.4"), ("1.2.3+gAAA", "1.2.3+gBBB"), ("  1.2.3  ", "1.2.3"),
        ]
        for (daemon, client) in cases {
            XCTAssertEqual(
                XCTestRunner.DaemonManager.requiresVersionSkewRestart(daemonVersion: daemon, clientVersion: client),
                XCTestRunnerRewrite.DaemonManager.requiresVersionSkewRestart(daemonVersion: daemon, clientVersion: client),
                "daemon=\(String(describing: daemon)) client=\(client)"
            )
        }
    }

    func testAssetVersionPinFailureParity() {
        let cases: [(String?, String?)] = [
            (nil, nil), ("1.2.3", nil), (nil, "1.2.3"), ("1.2.3", "1.2.3"),
            ("1.2.3", "1.2.4"), ("1.2.3", "latest"), ("1.2.3", "unknown"), ("", "1.2.3"),
        ]
        for (daemon, caller) in cases {
            XCTAssertEqual(
                XCTestRunner.DaemonManager.requiresAssetVersionPinFailure(daemonAssetVersion: daemon, callerPinnedVersion: caller),
                XCTestRunnerRewrite.DaemonManager.requiresAssetVersionPinFailure(daemonAssetVersion: daemon, callerPinnedVersion: caller),
                "daemon=\(String(describing: daemon)) caller=\(String(describing: caller))"
            )
        }
    }

    func testResolveCallerAssetVersionPinParity() {
        let envs: [[String: String]] = [
            [:], ["AUTOMOBILE_VERSION": "1.2.3"], ["AUTOMOBILE_VERSION": "latest"],
            ["AUTOMOBILE_VERSION": "unknown"], ["AUTOMOBILE_VERSION": "  "],
        ]
        for env in envs {
            XCTAssertEqual(
                XCTestRunner.DaemonManager.resolveCallerAssetVersionPin(environment: env),
                XCTestRunnerRewrite.DaemonManager.resolveCallerAssetVersionPin(environment: env),
                "env=\(env)"
            )
        }
    }

    // MARK: - Launch / version resolution parity

    func testResolveDaemonPackageVersionParity() {
        let envs: [[String: String]] = [
            [:], ["AUTOMOBILE_DAEMON_PACKAGE_VERSION": "1.2.3"], ["AUTOMOBILE_VERSION": "1.2.3"],
            ["AUTOMOBILE_VERSION": "latest"], ["AUTOMOBILE_VERSION": "  "],
            ["AUTOMOBILE_DAEMON_PACKAGE_VERSION": "9.9.9", "AUTOMOBILE_VERSION": "1.2.3"],
        ]
        for env in envs {
            XCTAssertEqual(
                XCTestRunner.DaemonManager.resolveDaemonPackageVersion(environment: env),
                XCTestRunnerRewrite.DaemonManager.resolveDaemonPackageVersion(environment: env),
                "env=\(env)"
            )
        }
    }

    func testResolveDaemonClientVersionParity() {
        let envs: [[String: String]] = [
            [:], ["AUTOMOBILE_VERSION": "1.2.3"], ["AUTOMOBILE_DAEMON_PACKAGE_VERSION": "1.2.3"],
        ]
        for hasBuiltEntry in [true, false] {
            for env in envs {
                XCTAssertEqual(
                    XCTestRunner.DaemonManager.resolveDaemonClientVersion(repoRootHasBuiltEntry: hasBuiltEntry, environment: env),
                    XCTestRunnerRewrite.DaemonManager.resolveDaemonClientVersion(repoRootHasBuiltEntry: hasBuiltEntry, environment: env),
                    "built=\(hasBuiltEntry) env=\(env)"
                )
            }
        }
    }

    func testDaemonLaunchEnvironmentParity() {
        let env = ["PATH": "/usr/bin:/bin", "FOO": "bar"]
        XCTAssertEqual(
            XCTestRunner.DaemonManager.daemonLaunchEnvironment(executable: "/opt/homebrew/bin/bun", environment: env),
            XCTestRunnerRewrite.DaemonManager.daemonLaunchEnvironment(executable: "/opt/homebrew/bin/bun", environment: env)
        )
    }

    func testDaemonLauncherTimeoutSecondsParity() {
        let envs: [[String: String]] = [[:], ["AUTOMOBILE_DAEMON_STARTUP_TIMEOUT_MS": "45000"], ["AUTOMOBILE_DAEMON_STARTUP_TIMEOUT_MS": "0"]]
        for subcommand in ["start", "restart"] {
            for env in envs {
                XCTAssertEqual(
                    XCTestRunner.DaemonManager.daemonLauncherTimeoutSeconds(subcommand: subcommand, readinessTimeoutSeconds: 15, environment: env),
                    XCTestRunnerRewrite.DaemonManager.daemonLauncherTimeoutSeconds(subcommand: subcommand, readinessTimeoutSeconds: 15, environment: env),
                    "sub=\(subcommand) env=\(env)"
                )
            }
        }
    }

    func testSelectDaemonLaunchParity() {
        // (localEntry, runtime, packageRunner, autoMobilePath, packageVersion)
        let cases: [(String?, String?, String?, String?, String?)] = [
            ("/repo/dist/src/index.js", "/bin/bun", "/bin/bunx", "/bin/auto-mobile", nil),
            (nil, nil, "/bin/bunx", "/bin/auto-mobile", "1.2.3"),
            (nil, nil, nil, "/bin/auto-mobile", "1.2.3"),
            (nil, nil, "/bin/npx", "/bin/auto-mobile", "not-semver"),
            (nil, nil, nil, "/bin/auto-mobile", nil),
            (nil, nil, nil, nil, nil),
        ]
        for (localEntry, runtime, packageRunner, autoMobilePath, packageVersion) in cases {
            let reference = XCTestRunner.DaemonManager.selectDaemonLaunch(
                subcommand: "start", localEntry: localEntry, runtime: runtime,
                packageRunner: packageRunner, autoMobilePath: autoMobilePath, packageVersion: packageVersion
            )
            let rewrite = XCTestRunnerRewrite.DaemonManager.selectDaemonLaunch(
                subcommand: "start", localEntry: localEntry, runtime: runtime,
                packageRunner: packageRunner, autoMobilePath: autoMobilePath, packageVersion: packageVersion
            )
            XCTAssertEqual(describe(reference), describe(rewrite), "case=\(String(describing: packageVersion))")
        }
    }

    func testDaemonStartupResultDiagnosticParity() {
        let pairs: [(XCTestRunner.DaemonStartupResult, XCTestRunnerRewrite.DaemonStartupResult)] = [
            (.ready, .ready), (.executableNotFound, .executableNotFound),
            (.packageRunnerNotFound, .packageRunnerNotFound),
            (.invalidPackageVersion("1.x"), .invalidPackageVersion("1.x")),
            (.launchFailed, .launchFailed), (.packageLaunchFailed(stderr: "boom"), .packageLaunchFailed(stderr: "boom")),
            (.launchTimeout, .launchTimeout), (.readinessTimeout, .readinessTimeout),
            (.versionSkew, .versionSkew), (.assetVersionSkew, .assetVersionSkew),
        ]
        for (reference, rewrite) in pairs {
            XCTAssertEqual(reference.isReady, rewrite.isReady)
            XCTAssertEqual(reference.diagnosticMessage, rewrite.diagnosticMessage)
        }
    }
}

// MARK: - Cross-module DaemonLaunch normalization

private func describe(_ launch: XCTestRunner.DaemonManager.DaemonLaunch) -> String {
    switch launch {
    case let .process(executable, arguments): return "process:\(executable):\(arguments.joined(separator: ","))"
    case .executableNotFound: return "executableNotFound"
    case .packageRunnerNotFound: return "packageRunnerNotFound"
    case let .invalidPackageVersion(version): return "invalidPackageVersion:\(version)"
    }
}

private func describe(_ launch: XCTestRunnerRewrite.DaemonLaunch) -> String {
    switch launch {
    case let .process(executable, arguments): return "process:\(executable):\(arguments.joined(separator: ","))"
    case .executableNotFound: return "executableNotFound"
    case .packageRunnerNotFound: return "packageRunnerNotFound"
    case let .invalidPackageVersion(version): return "invalidPackageVersion:\(version)"
    }
}
