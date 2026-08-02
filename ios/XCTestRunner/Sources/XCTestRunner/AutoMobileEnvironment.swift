import CryptoKit
import Darwin
import Foundation

struct AutoMobileEnvironment {
    private let values: [String: String]

    init(values: [String: String] = ProcessInfo.processInfo.environment) {
        self.values = values
    }

    func firstNonEmpty(_ keys: [String]) -> String? {
        for key in keys {
            if let value = values[key], !value.isEmpty {
                return value
            }
        }
        return nil
    }

    func intValue(_ keys: [String]) -> Int? {
        if let stringValue = firstNonEmpty(keys) {
            return Int(stringValue)
        }
        return nil
    }

    func doubleValue(_ keys: [String]) -> Double? {
        if let stringValue = firstNonEmpty(keys) {
            return Double(stringValue)
        }
        return nil
    }

    func boolValue(_ keys: [String]) -> Bool? {
        guard let value = firstNonEmpty(keys) else {
            return nil
        }
        return ["1", "true", "yes", "y"].contains(value.lowercased())
    }
}

enum AutoMobileDaemonSocket {
    static var defaultPath: String {
        let uid = String(getuid())
        return "/tmp/auto-mobile-daemon-\(uid).sock"
    }
}

enum SimulatorDetection {
    /// Check if any iOS simulator is currently booted (fast check)
    static func hasBootedSimulator() -> Bool {
        PerfTimer.log("hasBootedSimulator: starting xcrun simctl")
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
        process.arguments = ["simctl", "list", "devices", "booted", "--json"]

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice

        do {
            try process.run()
            PerfTimer.log("hasBootedSimulator: waiting for simctl to complete")
            process.waitUntilExit()

            guard process.terminationStatus == 0 else {
                PerfTimer.log("hasBootedSimulator: simctl failed with status \(process.terminationStatus)")
                return false
            }

            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            PerfTimer.log("hasBootedSimulator: parsing \(data.count) bytes of JSON")
            guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let devices = json["devices"] as? [String: [[String: Any]]]
            else {
                PerfTimer.log("hasBootedSimulator: failed to parse JSON")
                return false
            }

            var bootedCount = 0
            for (_, deviceList) in devices {
                bootedCount += deviceList.count
            }
            PerfTimer.log("hasBootedSimulator: found \(bootedCount) booted simulators")
            return bootedCount > 0
        } catch {
            PerfTimer.log("hasBootedSimulator: ERROR - \(error)")
            return false
        }
    }
}

/// The concrete reason a daemon-startup attempt succeeded or failed. Surfaced to
/// callers (e.g. the XCTest skip message) so a failure names the actual cause
/// instead of a generic "install and on PATH" note that hides an executable-not-found
/// vs. launch-failure vs. readiness-timeout distinction (#2730).
public enum DaemonStartupResult: Equatable {
    case ready
    case executableNotFound
    case packageRunnerNotFound
    case launchFailed
    case packageLaunchFailed(stderr: String)
    case launchTimeout
    case readinessTimeout
    case versionSkew
    case assetVersionSkew

    public var isReady: Bool { self == .ready }

    public var diagnosticMessage: String {
        switch self {
        case .ready:
            return "AutoMobile daemon is ready."
        case .executableNotFound:
            return "Failed to start AutoMobile Daemon: the `auto-mobile` CLI was not found "
                + "(checked /usr/local/bin, /opt/homebrew/bin, /usr/bin, ~/.bun/bin, ~/.local/bin and PATH). "
                + "Install it globally (`bun add -g .`) and ensure its bin directory is on PATH."
        case .packageRunnerNotFound:
            return "Failed to start AutoMobile Daemon: a pinned daemon requires `bunx` or `npx`, but neither "
                + "was found on PATH. Install Bun or Node.js with npm/npx, then retry."
        case .launchFailed:
            return "Failed to start AutoMobile Daemon: `auto-mobile --daemon start` exited non-zero. "
                + "Check the daemon logs."
        case let .packageLaunchFailed(stderr):
            return "Failed to start AutoMobile Daemon: the package runner exited non-zero. "
                + "Package-runner error: \(stderr.trimmingCharacters(in: .whitespacesAndNewlines))."
        case .launchTimeout:
            return "Failed to start AutoMobile Daemon: the daemon launcher timed out before it completed. "
                + "Check package-registry connectivity and daemon logs."
        case .readinessTimeout:
            return "Failed to start AutoMobile Daemon: the daemon process launched but its socket did not "
                + "become ready before the timeout. Check the daemon logs."
        case .versionSkew:
            return "Failed to start AutoMobile Daemon: a different-version daemon owns the socket and could "
                + "not be reconciled with this runner."
        case .assetVersionSkew:
            return "Failed to start AutoMobile Daemon: the shared daemon was started with a different "
                + "AUTOMOBILE_VERSION pin than this runner. Restart the daemon from this runner's environment."
        }
    }
}

/// Injectable process and PID-file boundary for daemon lifecycle decisions. Tests use a fake so
/// build-skew restarts are verified without touching the caller's shared daemon.
protocol DaemonRuntime {
    func isDaemonRunning() -> Bool
    func readDaemonVersion() -> String?
    func readDaemonAssetVersion() -> String?
    func readDaemonEntryScript() -> String?
    func readDaemonBuildId() -> String?
    func runDaemonSubcommand(
        _ subcommand: String,
        repoRoot: String?,
        timeoutSeconds: TimeInterval
    ) -> DaemonManager.DaemonSubcommandOutcome
    func waitForDaemon(timeoutSeconds: TimeInterval) -> Bool
}

public enum DaemonManager {
    private struct PackageMetadata: Decodable {
        let name: String?
    }

    private static let packageName = "@kaeawc/auto-mobile"

    /// Outcome of launching an `auto-mobile --daemon <subcommand>` process, distinguishing a
    /// missing executable from a launched-but-failed process so callers can report the real cause.
    enum DaemonSubcommandOutcome: Equatable {
        case launched
        case executableNotFound
        case packageRunnerNotFound
        case failed(stderr: String? = nil)
        case packageFailed(stderr: String? = nil)
        case timedOut
    }

    enum DaemonLaunch: Equatable {
        case process(executable: String, arguments: [String])
        case executableNotFound
        case packageRunnerNotFound
    }

    /// Injectable subprocess boundary so launcher timeouts are deterministic in unit tests.
    protocol DaemonSubcommandLauncher {
        func launch(
            executable: String,
            arguments: [String],
            environment: [String: String],
            timeoutSeconds: TimeInterval
        ) -> DaemonSubcommandOutcome
    }

    private final class BoundedStandardError {
        private static let maximumBytes = 4096
        private let lock = NSLock()
        private var data = Data()
        let pipe = Pipe()

        init() {
            pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
                self?.append(handle.availableData)
            }
        }

        func text() -> String? {
            pipe.fileHandleForReading.readabilityHandler = nil
            append(pipe.fileHandleForReading.readDataToEndOfFile())
            lock.lock()
            defer { lock.unlock() }
            guard !data.isEmpty else { return nil }
            return String(data: data, encoding: .utf8)
        }

        private func append(_ incoming: Data) {
            guard !incoming.isEmpty else { return }
            lock.lock()
            defer { lock.unlock() }
            let remaining = Self.maximumBytes - data.count
            guard remaining > 0 else { return }
            data.append(incoming.prefix(remaining))
        }

        deinit {
            pipe.fileHandleForReading.readabilityHandler = nil
        }
    }

    private struct SystemDaemonSubcommandLauncher: DaemonSubcommandLauncher {
        func launch(
            executable: String,
            arguments: [String],
            environment: [String: String],
            timeoutSeconds: TimeInterval
        ) -> DaemonSubcommandOutcome {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: executable)
            process.arguments = arguments
            process.environment = environment
            process.standardOutput = FileHandle.nullDevice
            let stderr = BoundedStandardError()
            process.standardError = stderr.pipe

            do {
                let completion = DispatchSemaphore(value: 0)
                process.terminationHandler = { _ in completion.signal() }
                try process.run()
                PerfTimer.log("runDaemonSubcommand: process launched, waiting for exit")
                guard completion.wait(timeout: .now() + timeoutSeconds) == .success else {
                    PerfTimer.log("runDaemonSubcommand: launcher timed out after \(timeoutSeconds)s")
                    process.terminate()
                    return .timedOut
                }
                let status = process.terminationStatus
                PerfTimer.log("runDaemonSubcommand: process exited with status \(status)")
                return status == 0 ? .launched : .failed(stderr: stderr.text())
            } catch {
                PerfTimer.log("runDaemonSubcommand: ERROR - failed to run process: \(error)")
                return .failed(stderr: error.localizedDescription)
            }
        }
    }

    private struct SystemDaemonRuntime: DaemonRuntime {
        func isDaemonRunning() -> Bool {
            DaemonManager.isDaemonRunning()
        }

        func readDaemonVersion() -> String? {
            DaemonManager.readDaemonVersionFromPidFile()
        }

        func readDaemonAssetVersion() -> String? {
            DaemonManager.readDaemonAssetVersionFromPidFile()
        }

        func readDaemonEntryScript() -> String? {
            DaemonManager.readDaemonEntryScriptFromPidFile()
        }

        func readDaemonBuildId() -> String? {
            DaemonManager.readDaemonBuildIdFromPidFile()
        }

        func runDaemonSubcommand(
            _ subcommand: String,
            repoRoot: String?,
            timeoutSeconds: TimeInterval
        ) -> DaemonSubcommandOutcome {
            DaemonManager.runDaemonSubcommand(
                subcommand,
                repoRoot: repoRoot,
                timeoutSeconds: timeoutSeconds
            )
        }

        func waitForDaemon(timeoutSeconds: TimeInterval) -> Bool {
            DaemonManager.waitForDaemon(timeoutSeconds: timeoutSeconds)
        }
    }

    public struct PidFileData: Decodable {
        public let pid: Int
        public let port: Int?
        public let socketPath: String?
        public let startedAt: Int64?
        public let version: String?
        public let assetVersion: String?
        public let entryScript: String?
        public let buildId: String?
    }

    public static var pidFilePath: String {
        let uid = String(getuid())
        return ProcessInfo.processInfo.environment["AUTOMOBILE_DAEMON_PID_FILE_PATH"]
            ?? ProcessInfo.processInfo.environment["AUTO_MOBILE_DAEMON_PID_FILE_PATH"]
            ?? "/tmp/auto-mobile-daemon-\(uid).pid"
    }

    public static var socketPath: String {
        let uid = String(getuid())
        return ProcessInfo.processInfo.environment["AUTOMOBILE_DAEMON_SOCKET_PATH"]
            ?? ProcessInfo.processInfo.environment["AUTO_MOBILE_DAEMON_SOCKET_PATH"]
            ?? "/tmp/auto-mobile-daemon-\(uid).sock"
    }

    public static func isDaemonRunning() -> Bool {
        guard FileManager.default.fileExists(atPath: pidFilePath) else {
            return false
        }
        guard let data = FileManager.default.contents(atPath: pidFilePath),
              let pidData = try? JSONDecoder().decode(PidFileData.self, from: data)
        else {
            return false
        }
        return isProcessRunning(pid: pidData.pid)
    }

    public static func isProcessRunning(pid: Int) -> Bool {
        return kill(Int32(pid), 0) == 0
    }

    public static func startDaemon(repoRoot: String? = nil) -> Bool {
        return runDaemonSubcommand("start", repoRoot: repoRoot) == .launched
    }

    /// Launch the daemon, returning the granular outcome (missing CLI vs. failed launch vs. launched)
    /// so the readiness path can report the real cause rather than a bare bool.
    static func startDaemonOutcome(repoRoot: String? = nil) -> DaemonSubcommandOutcome {
        return runDaemonSubcommand("start", repoRoot: repoRoot)
    }

    /// Map a launch/restart outcome to the startup failure it represents, or nil when the process
    /// launched cleanly. Pure so the failure-cause mapping is unit-testable without spawning a
    /// process, and shared by the start and restart paths so both stay in sync.
    static func startupFailure(for outcome: DaemonSubcommandOutcome) -> DaemonStartupResult? {
        switch outcome {
        case .launched:
            return nil
        case .executableNotFound:
            return .executableNotFound
        case .packageRunnerNotFound:
            return .packageRunnerNotFound
        case let .failed(stderr):
            return failureResult(stderr: stderr, packageRunner: false)
        case let .packageFailed(stderr):
            return failureResult(stderr: stderr, packageRunner: true)
        case .timedOut:
            return .launchTimeout
        }
    }

    private static func failureResult(stderr: String?, packageRunner: Bool) -> DaemonStartupResult {
        guard let stderr = stderr?.trimmingCharacters(in: .whitespacesAndNewlines), !stderr.isEmpty else {
            return .launchFailed
        }
        if packageRunner {
            return .packageLaunchFailed(stderr: stderr)
        }
        return .launchFailed
    }

    static func classifyDaemonSubcommandOutcome(
        _ outcome: DaemonSubcommandOutcome,
        packageRunner: Bool
    ) -> DaemonSubcommandOutcome {
        guard packageRunner, case let .failed(stderr) = outcome else { return outcome }
        return .packageFailed(stderr: stderr)
    }

    /// Restart the daemon in place — used to replace a stale different-build daemon that owns
    /// the shared per-uid socket (#2744) so the runner self-heals instead of failing the
    /// version handshake. Mirrors the Android runner's PID-file version-skew restart.
    public static func restartDaemon(repoRoot: String? = nil) -> Bool {
        return runDaemonSubcommand("restart", repoRoot: repoRoot) == .launched
    }

    static func runDaemonSubcommand(
        _ subcommand: String,
        repoRoot: String? = nil,
        timeoutSeconds: TimeInterval = 15,
        launcher: DaemonSubcommandLauncher = SystemDaemonSubcommandLauncher()
    ) -> DaemonSubcommandOutcome {
        // When a repo root with a built entrypoint is provided, launch *that* checkout's daemon
        // (`<repoRoot>/dist/src/index.js`) rather than whatever `auto-mobile` is on PATH — so a
        // caller that knows its source build gets a version/build-matched daemon (#2744) instead of
        // a same-release-but-different-checkout PATH binary. A concrete package pin takes the
        // next precedence, and an unpinned launch falls back to the PATH binary.
        let effectiveRepoRoot = resolveDaemonRepoRoot(repoRoot)
        let localEntry = resolveRepoRootDaemonEntryScript(effectiveRepoRoot)
        let runtime = findExecutable("bun") ?? findExecutable("node")
        let launch = selectDaemonLaunch(
            subcommand: subcommand,
            localEntry: localEntry,
            runtime: runtime,
            packageRunner: findExecutable("bunx") ?? findExecutable("npx"),
            autoMobilePath: findExecutable("auto-mobile")
        )
        let executable: String
        let arguments: [String]
        switch launch {
        case let .process(launchExecutable, launchArguments):
            executable = launchExecutable
            arguments = launchArguments
        case .executableNotFound:
            PerfTimer.log("runDaemonSubcommand: ERROR - no compatible daemon executable found")
            return .executableNotFound
        case .packageRunnerNotFound:
            PerfTimer.log("runDaemonSubcommand: ERROR - pinned daemon package runner not found")
            return .packageRunnerNotFound
        }

        let hasLocalBuild = localEntry != nil && runtime != nil
        if hasLocalBuild {
            PerfTimer.log("runDaemonSubcommand(\(subcommand)): launching local build")
        } else if resolveDaemonPackageSpecifier(resolveDaemonPackageVersion()) != nil {
            PerfTimer.log("runDaemonSubcommand(\(subcommand)): launching pinned package")
        } else {
            PerfTimer.log("runDaemonSubcommand(\(subcommand)): launching auto-mobile from PATH")
        }

        let env = daemonLaunchEnvironment(executable: executable)
        let launcherTimeoutSeconds = daemonLauncherTimeoutSeconds(
            subcommand: subcommand,
            readinessTimeoutSeconds: timeoutSeconds
        )
        let outcome = executeDaemonLaunch(
            executable: executable,
            arguments: arguments,
            environment: env,
            timeoutSeconds: launcherTimeoutSeconds,
            launcher: launcher
        )
        return classifyDaemonSubcommandOutcome(
            outcome,
            packageRunner: !hasLocalBuild && resolveDaemonPackageSpecifier(resolveDaemonPackageVersion()) != nil
        )
    }

    static func daemonLaunchEnvironment(
        executable: String,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> [String: String] {
        var environment = environment
        let existingPaths = (environment["PATH"] ?? "").split(separator: ":").map(String.init)
        let requiredPaths = [
            URL(fileURLWithPath: executable).deletingLastPathComponent().path,
            "/usr/bin",
            "/usr/local/bin",
        ]
        environment["PATH"] = (requiredPaths + existingPaths)
            .reduce(into: [String]()) { paths, path in
                if !paths.contains(path) { paths.append(path) }
            }
            .joined(separator: ":")
        return environment
    }

    static func daemonLauncherTimeoutSeconds(
        subcommand: String,
        readinessTimeoutSeconds: TimeInterval,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> TimeInterval {
        let configuredStartupMilliseconds = Int(environment["AUTOMOBILE_DAEMON_STARTUP_TIMEOUT_MS"] ?? "")
            ?? Int(environment["AUTO_MOBILE_DAEMON_STARTUP_TIMEOUT_MS"] ?? "")
            ?? 10_000
        let startupSeconds = configuredStartupMilliseconds > 0
            ? TimeInterval(configuredStartupMilliseconds) / 1000
            : 10
        // DaemonManager can wait for a lock holder, then make two startup attempts while
        // recovering an incomplete package extraction, each with the configured startup budget.
        let startupLifecycleSeconds = 3 * startupSeconds
        guard subcommand == "restart" else {
            return max(readinessTimeoutSeconds, startupLifecycleSeconds)
        }
        // DaemonManager.restart additionally allows shutdown (5s) and an inter-phase delay (1s).
        return max(readinessTimeoutSeconds, 6 + startupLifecycleSeconds)
    }

    static func executeDaemonLaunch(
        executable: String,
        arguments: [String],
        environment: [String: String],
        timeoutSeconds: TimeInterval,
        launcher: DaemonSubcommandLauncher
    ) -> DaemonSubcommandOutcome {
        PerfTimer.log("runDaemonSubcommand: launching process with args: \(arguments)")
        return launcher.launch(
            executable: executable,
            arguments: arguments,
            environment: environment,
            timeoutSeconds: timeoutSeconds
        )
    }

    static func selectDaemonLaunch(
        subcommand: String,
        localEntry: String?,
        runtime: String?,
        packageRunner: String?,
        autoMobilePath: String?,
        packageVersion: String? = resolveDaemonPackageVersion()
    ) -> DaemonLaunch {
        if let localEntry, let runtime {
            PerfTimer.log("runDaemonSubcommand(\(subcommand)): launching local build at \(localEntry)")
            return .process(executable: runtime, arguments: [localEntry, "--daemon", subcommand])
        }
        if let packageSpecifier = resolveDaemonPackageSpecifier(packageVersion) {
            guard let packageRunner else {
                return .packageRunnerNotFound
            }
            return .process(
                executable: packageRunner,
                arguments: packageDaemonArguments(
                    packageRunner: packageRunner,
                    packageSpecifier: packageSpecifier,
                    subcommand: subcommand
                )
            )
        }
        guard let autoMobilePath else {
            return .executableNotFound
        }
        return .process(executable: autoMobilePath, arguments: ["--daemon", subcommand])
    }

    /// Builds the package-runner arguments for an explicit daemon version pin. `bunx` does not
    /// require confirmation, while `npx` needs `-y` to keep XCTest runs non-interactive.
    static func buildPackageDaemonCommand(
        packageRunner: String,
        subcommand: String,
        packageVersion: String? = resolveDaemonPackageVersion()
    ) -> [String]? {
        guard let packageSpecifier = resolveDaemonPackageSpecifier(packageVersion) else {
            return nil
        }

        return packageDaemonArguments(
            packageRunner: packageRunner,
            packageSpecifier: packageSpecifier,
            subcommand: subcommand
        )
    }

    /// The package version a non-checkout XCTestRunner daemon launch should use. An explicit
    /// daemon-package pin takes precedence over the shared release pin, matching Android.
    static func resolveDaemonPackageVersion(
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> String? {
        let explicitPin = environment["AUTOMOBILE_DAEMON_PACKAGE_VERSION"]?
            .trimmingCharacters(in: .whitespaces)
        if let explicitPin, !explicitPin.isEmpty {
            return explicitPin
        }

        let automobileVersion = environment["AUTOMOBILE_VERSION"]?.trimmingCharacters(in: .whitespaces)
        return automobileVersion?.isEmpty == false ? automobileVersion : nil
    }

    private static func resolveDaemonPackageSpecifier(_ packageVersion: String?) -> String? {
        guard let version = packageVersion?.trimmingCharacters(in: .whitespaces),
              !version.isEmpty,
              version.lowercased() != "latest",
              version.lowercased() != "unknown"
        else {
            return nil
        }
        return "\(packageName)@\(version)"
    }

    private static func packageDaemonArguments(
        packageRunner: String,
        packageSpecifier: String,
        subcommand: String
    ) -> [String] {
        let prefix = URL(fileURLWithPath: packageRunner).deletingPathExtension().lastPathComponent == "npx"
            ? ["-y"]
            : []
        return prefix + [packageSpecifier, "--daemon", subcommand]
    }

    static func resolveDaemonClientVersion(
        repoRoot: String? = nil,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> String {
        let effectiveRepoRoot = resolveDaemonRepoRoot(repoRoot, environment: environment)
        return resolveDaemonClientVersion(
            repoRootHasBuiltEntry: resolveRepoRootDaemonEntryScript(effectiveRepoRoot) != nil,
            environment: environment
        )
    }

    /// The checkout used for both daemon launch and the matching client handshake. A caller may
    /// supply a root explicitly; otherwise XCTestRunner's own source checkout is used when built.
    static func resolveDaemonRepoRoot(
        _ repoRoot: String?,
        inferredRepoRoot: String? = nil,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> String? {
        repoRoot
            ?? inferredRepoRoot
            ?? AutoMobileEnvironment(values: environment).firstNonEmpty(["AUTOMOBILE_REPO_ROOT"])
            ?? findRepoRoot(startingAt: #filePath)
    }

    static func resolveDaemonClientVersion(
        repoRootHasBuiltEntry: Bool,
        environment: [String: String]
    ) -> String {
        guard !repoRootHasBuiltEntry,
              let packageVersion = resolveDaemonPackageSpecifier(resolveDaemonPackageVersion(environment: environment))
        else {
            return AutoMobileVersion.current
        }
        return String(packageVersion.dropFirst(packageName.count + 1))
    }

    /// The daemon's recorded version from its PID file, trimmed, or nil when absent/unreadable.
    static func readDaemonVersionFromPidFile() -> String? {
        guard let data = FileManager.default.contents(atPath: pidFilePath),
              let pidData = try? JSONDecoder().decode(PidFileData.self, from: data),
              let version = pidData.version?.trimmingCharacters(in: .whitespaces),
              !version.isEmpty
        else {
            return nil
        }
        return version
    }

    /// The daemon's recorded CtrlProxy asset version from its PID file, trimmed, or nil.
    static func readDaemonAssetVersionFromPidFile() -> String? {
        guard let data = FileManager.default.contents(atPath: pidFilePath),
              let pidData = try? JSONDecoder().decode(PidFileData.self, from: data),
              let assetVersion = pidData.assetVersion?.trimmingCharacters(in: .whitespaces),
              !assetVersion.isEmpty
        else {
            return nil
        }
        return assetVersion
    }

    /// The daemon's recorded entry-script path from its PID file, trimmed, or nil when absent.
    static func readDaemonEntryScriptFromPidFile() -> String? {
        guard let data = FileManager.default.contents(atPath: pidFilePath),
              let pidData = try? JSONDecoder().decode(PidFileData.self, from: data),
              let entryScript = pidData.entryScript?.trimmingCharacters(in: .whitespaces),
              !entryScript.isEmpty
        else {
            return nil
        }
        return entryScript
    }

    /// The daemon's recorded build-identity hash from its PID file, trimmed, or nil when absent.
    static func readDaemonBuildIdFromPidFile() -> String? {
        guard let data = FileManager.default.contents(atPath: pidFilePath),
              let pidData = try? JSONDecoder().decode(PidFileData.self, from: data),
              let buildId = pidData.buildId?.trimmingCharacters(in: .whitespaces),
              !buildId.isEmpty
        else {
            return nil
        }
        return buildId
    }

    /// Short content hash of an entry script (sha256, first 16 hex chars) — matches the daemon's
    /// `computeBuildIdentity`, so the value compares equal to the daemon's own recorded build id.
    static func computeBuildId(_ entryScript: String) -> String? {
        guard let data = FileManager.default.contents(atPath: entryScript) else {
            return nil
        }
        let hex = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        return String(hex.prefix(16))
    }

    /// When a caller supplies a repo root with a built entrypoint, whether the running daemon was
    /// started from a *different* build (#2744). The daemon must identify both the expected
    /// entry-script path and its content hash: the path keeps separately copied runtime artifacts
    /// (such as `dist/schemas/`) scoped to this checkout, while the hash catches an in-place rebuild.
    /// Falls back to the entry-script path when a hash is unavailable. No-op without a repoRoot
    /// build or when neither signal is available.
    static func requiresRepoRootBuildSkew(
        daemonBuildId: String?,
        daemonEntryScript: String?,
        repoRoot: String?
    )
        -> Bool
    {
        guard let expectedEntry = resolveRepoRootDaemonEntryScript(repoRoot) else {
            return false
        }
        let expectedHash = computeBuildId(expectedEntry)
        let daemonHash = daemonBuildId?.trimmingCharacters(in: .whitespaces)
        let daemonEntry = daemonEntryScript?.trimmingCharacters(in: .whitespaces)
        let hasExpectedEntry = daemonEntry == expectedEntry
        guard let expectedHash = expectedHash,
              let daemonHash = daemonHash, !daemonHash.isEmpty, daemonHash != "unknown"
        else {
            return daemonEntry.map { !$0.isEmpty && !hasExpectedEntry } ?? false
        }
        return daemonHash != expectedHash || !hasExpectedEntry
    }

    /// The release portion of a version string — everything before the `+g<sha>` dev stamp.
    /// Mirrors the daemon's `releaseVersion`, so a git-stamped source-checkout daemon compares
    /// equal to this runner's plain release.
    static func releaseVersion(_ version: String) -> String {
        return String(version.split(separator: "+", maxSplits: 1, omittingEmptySubsequences: false)
            .first ?? Substring(version))
    }

    /// Whether an already-running daemon must be restarted before reuse because its recorded
    /// version does not match this runner's (#2744). Compares release portions; a blank/unknown
    /// version on either side yields false so an unidentifiable daemon is not thrashed.
    static func requiresVersionSkewRestart(daemonVersion: String?, clientVersion: String) -> Bool {
        guard let daemonVersion = daemonVersion?.trimmingCharacters(in: .whitespaces), !daemonVersion.isEmpty else {
            return false
        }
        let client = clientVersion.trimmingCharacters(in: .whitespaces)
        if client.isEmpty {
            return false
        }
        return releaseVersion(daemonVersion) != releaseVersion(client)
    }

    static func resolveCallerAssetVersionPin(
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> String? {
        guard let pinned = environment["AUTOMOBILE_VERSION"]?.trimmingCharacters(in: .whitespaces),
              !pinned.isEmpty,
              pinned.lowercased() != "latest",
              pinned.lowercased() != "unknown"
        else {
            return nil
        }
        return pinned
    }

    static func requiresAssetVersionPinFailure(
        daemonAssetVersion: String?,
        callerPinnedVersion: String?
    ) -> Bool {
        let daemon = daemonAssetVersion?.trimmingCharacters(in: .whitespaces) ?? ""
        guard let caller = callerPinnedVersion?.trimmingCharacters(in: .whitespaces),
              !caller.isEmpty,
              caller.lowercased() != "latest",
              caller.lowercased() != "unknown"
        else {
            return false
        }
        return daemon != caller
    }

    static func requiresImmediateAssetVersionPinFailure(
        assetVersionSkew: Bool,
        versionSkew: Bool,
        buildSkew: Bool
    ) -> Bool {
        assetVersionSkew && !versionSkew && !buildSkew
    }

    public static func ensureDaemonRunning(repoRoot: String? = nil, timeoutSeconds: TimeInterval = 15) -> Bool {
        return ensureDaemonRunningResult(repoRoot: repoRoot, timeoutSeconds: timeoutSeconds).isReady
    }

    /// Same behavior as `ensureDaemonRunning` but returns the granular `DaemonStartupResult` so
    /// callers can report *why* startup failed (missing CLI, launch failure, readiness timeout,
    /// version skew) instead of a generic message.
    public static func ensureDaemonRunningResult(
        repoRoot: String? = nil,
        timeoutSeconds: TimeInterval = 15
    )
        -> DaemonStartupResult
    {
        return ensureDaemonRunningResult(
            repoRoot: repoRoot,
            timeoutSeconds: timeoutSeconds,
            runtime: SystemDaemonRuntime()
        )
    }

    static func ensureDaemonRunningResult(
        repoRoot: String?,
        timeoutSeconds: TimeInterval,
        runtime: DaemonRuntime,
        callerAssetVersion: String? = resolveCallerAssetVersionPin(),
        clientVersion: String? = nil,
        inferredRepoRoot: String? = nil,
        environment: [String: String] = ProcessInfo.processInfo.environment
    )
        -> DaemonStartupResult
    {
        let effectiveRepoRoot = resolveDaemonRepoRoot(repoRoot, inferredRepoRoot: inferredRepoRoot)
        let launcherTimeoutSeconds = daemonLauncherTimeoutSeconds(
            subcommand: "restart",
            readinessTimeoutSeconds: timeoutSeconds,
            environment: environment
        )
        let expectedClientVersion = clientVersion ?? resolveDaemonClientVersion(repoRoot: effectiveRepoRoot)
        PerfTimer.log("ensureDaemonRunning: checking isDaemonRunning")
        if runtime.isDaemonRunning() {
            // A stale different-build daemon on the shared socket would reject this runner's
            // version handshake (#2744). Restart it before reuse so we self-heal instead of
            // failing, mirroring the Android/TS version-skew restart. When a repoRoot is supplied,
            // also restart a same-release daemon started from a different checkout's entry script.
            let versionSkew = requiresVersionSkewRestart(
                daemonVersion: runtime.readDaemonVersion(),
                clientVersion: expectedClientVersion
            )
            let buildSkew = requiresRepoRootBuildSkew(
                daemonBuildId: runtime.readDaemonBuildId(),
                daemonEntryScript: runtime.readDaemonEntryScript(),
                repoRoot: effectiveRepoRoot
            )
            let assetVersionSkew = requiresAssetVersionPinFailure(
                daemonAssetVersion: runtime.readDaemonAssetVersion(),
                callerPinnedVersion: callerAssetVersion
            )
            if requiresImmediateAssetVersionPinFailure(
                assetVersionSkew: assetVersionSkew,
                versionSkew: versionSkew,
                buildSkew: buildSkew
            ) {
                PerfTimer.log("ensureDaemonRunning: daemon AUTOMOBILE_VERSION pin mismatch")
                return .assetVersionSkew
            }
            if versionSkew || buildSkew || assetVersionSkew {
                PerfTimer.log("ensureDaemonRunning: daemon version/build skew, restarting")
                if let failure = startupFailure(for: runtime.runDaemonSubcommand(
                    "restart",
                    repoRoot: effectiveRepoRoot,
                    timeoutSeconds: launcherTimeoutSeconds
                )) {
                    PerfTimer.log("ensureDaemonRunning: restartDaemon failed - \(failure)")
                    return failure
                }
                return waitForVersionMatchedDaemon(
                    repoRoot: effectiveRepoRoot,
                    timeoutSeconds: timeoutSeconds,
                    runtime: runtime,
                    callerAssetVersion: callerAssetVersion,
                    clientVersion: expectedClientVersion
                )
            }
            PerfTimer.log("ensureDaemonRunning: daemon already running")
            return .ready
        }

        PerfTimer.log("ensureDaemonRunning: starting daemon")
        if let failure = startupFailure(for: runtime.runDaemonSubcommand(
            "start",
            repoRoot: effectiveRepoRoot,
            timeoutSeconds: timeoutSeconds
        )) {
            PerfTimer.log("ensureDaemonRunning: startDaemon failed - \(failure)")
            return failure
        }

        return waitForVersionMatchedDaemon(
            repoRoot: effectiveRepoRoot,
            timeoutSeconds: timeoutSeconds,
            runtime: runtime,
            callerAssetVersion: callerAssetVersion,
            clientVersion: expectedClientVersion
        )
    }

    /// Wait for the daemon to become ready and confirm its recorded version matches this runner's.
    /// `start`/`restart` launch whatever `auto-mobile` is on PATH — which may be a different version
    /// than this runner's baked `AutoMobileVersion.current` — and `waitForDaemon` only checks
    /// pid/socket liveness, so without this a wrong-version daemon would look "ready" while its
    /// handshake gate (#2744) rejects every subsequent request. A daemon that records no version is
    /// accepted (a skew cannot be proven), matching the gate's lenient stance.
    private static func waitForVersionMatchedDaemon(
        repoRoot: String?,
        timeoutSeconds: TimeInterval,
        runtime: DaemonRuntime,
        callerAssetVersion: String?,
        clientVersion: String
    )
        -> DaemonStartupResult
    {
        PerfTimer.log("ensureDaemonRunning: waiting for daemon")
        guard runtime.waitForDaemon(timeoutSeconds: timeoutSeconds) else {
            return .readinessTimeout
        }
        if requiresVersionSkewRestart(
            daemonVersion: runtime.readDaemonVersion(),
            clientVersion: clientVersion
        ) || requiresRepoRootBuildSkew(
            daemonBuildId: runtime.readDaemonBuildId(),
            daemonEntryScript: runtime.readDaemonEntryScript(),
            repoRoot: repoRoot
            ) || requiresAssetVersionPinFailure(
                daemonAssetVersion: runtime.readDaemonAssetVersion(),
                callerPinnedVersion: callerAssetVersion
        ) {
            PerfTimer.log("ensureDaemonRunning: daemon still differs from runner after launch")
            if requiresAssetVersionPinFailure(
                daemonAssetVersion: runtime.readDaemonAssetVersion(),
                callerPinnedVersion: resolveCallerAssetVersionPin()
            ) {
                return .assetVersionSkew
            }
            return .versionSkew
        }
        return .ready
    }

    public static func waitForDaemon(timeoutSeconds: TimeInterval) -> Bool {
        PerfTimer.log("waitForDaemon: timeout=\(timeoutSeconds)s")
        let deadline = Date().addingTimeInterval(timeoutSeconds)
        var pollCount = 0
        while Date() < deadline {
            pollCount += 1
            if isDaemonRunning() && FileManager.default.fileExists(atPath: socketPath) {
                PerfTimer.log("waitForDaemon: ready after \(pollCount) polls")
                return true
            }
            Thread.sleep(forTimeInterval: 0.2)
        }
        PerfTimer.log("waitForDaemon: TIMEOUT after \(pollCount) polls")
        return false
    }

    /// Finds the owning AutoMobile checkout for a runner source path. The caller still verifies the
    /// built entrypoint before using it, so package consumers without `dist/` retain PATH behavior.
    /// A package file alone is not enough: XCTestRunner may be vendored in a host JavaScript project.
    static func findRepoRoot(startingAt sourcePath: String) -> String? {
        var directory = URL(fileURLWithPath: sourcePath).deletingLastPathComponent()
        while directory.path != "/" {
            let packageURL = directory.appendingPathComponent("package.json")
            if let data = try? Data(contentsOf: packageURL),
               let package = try? JSONDecoder().decode(PackageMetadata.self, from: data),
               package.name == packageName
            {
                return directory.path
            }
            directory.deleteLastPathComponent()
        }
        return nil
    }

    /// Resolve the built daemon entrypoint under a caller-provided repo root, or nil when no root
    /// is given or the build is absent (so the caller falls back to the PATH `auto-mobile`).
    static func resolveRepoRootDaemonEntryScript(_ repoRoot: String?) -> String? {
        guard let repoRoot = repoRoot, !repoRoot.isEmpty else {
            return nil
        }
        let entry = URL(fileURLWithPath: repoRoot)
            .appendingPathComponent("dist/src/index.js").path
        return FileManager.default.fileExists(atPath: entry) ? entry : nil
    }

    private static func findExecutable(_ name: String) -> String? {
        let commonPaths = [
            "/usr/local/bin/\(name)",
            "/opt/homebrew/bin/\(name)",
            "/usr/bin/\(name)",
            "\(NSHomeDirectory())/.bun/bin/\(name)",
            "\(NSHomeDirectory())/.local/bin/\(name)",
        ]
        for path in commonPaths where FileManager.default.isExecutableFile(atPath: path) {
            return path
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/which")
        process.arguments = [name]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            process.waitUntilExit()
            if process.terminationStatus == 0 {
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                if let path = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
                   !path.isEmpty
                {
                    return path
                }
            }
        } catch {}
        return nil
    }

    public struct RefreshDevicesResult {
        public let success: Bool
        public let addedDevices: Int
        public let totalDevices: Int
        public let availableDevices: Int
    }

    public static func releaseSession(_ sessionId: String) -> Bool {
        guard isDaemonRunning() else {
            print("[AutoMobile] Cannot release session: daemon not running")
            return false
        }

        let requestId = UUID().uuidString
        let request: [String: Any] = [
            "id": requestId,
            "type": "daemon_request",
            "method": "daemon/releaseSession",
            "params": ["sessionId": sessionId],
            // Declared for the daemon's server-side version handshake gate (#2744).
            "clientVersion": resolveDaemonClientVersion(),
        ]

        guard let requestData = try? JSONSerialization.data(withJSONObject: request),
              var requestLine = String(data: requestData, encoding: .utf8)
        else {
            print("[AutoMobile] Failed to serialize release session request")
            return false
        }
        requestLine.append("\n")

        let result = sendDaemonRequest(requestLine, timeoutSeconds: 5)
        if let result = result, let success = result["success"] as? Bool, success {
            if let resultData = result["result"] as? [String: Any],
               let alreadyReleased = resultData["alreadyReleased"] as? Bool,
               alreadyReleased
            {
                print("[AutoMobile] Session \(sessionId) was already released (auto-released by daemon)")
            } else {
                print("[AutoMobile] Session \(sessionId) released")
            }
            return true
        }
        if let result = result, let error = result["error"] as? String {
            print("[AutoMobile] Failed to release session \(sessionId): \(error)")
        } else {
            print("[AutoMobile] Failed to release session \(sessionId)")
        }
        return false
    }

    public static func refreshDevicePool(timeoutSeconds: TimeInterval = 30) -> RefreshDevicesResult {
        PerfTimer.log("refreshDevicePool START")
        guard isDaemonRunning() else {
            PerfTimer.log("refreshDevicePool: daemon not running")
            return RefreshDevicesResult(success: false, addedDevices: 0, totalDevices: 0, availableDevices: 0)
        }

        let requestId = UUID().uuidString
        let request: [String: Any] = [
            "id": requestId,
            "type": "daemon_request",
            "method": "daemon/refreshDevices",
            "params": [String: Any](),
            // Declared for the daemon's server-side version handshake gate (#2744).
            "clientVersion": resolveDaemonClientVersion(),
        ]

        guard let requestData = try? JSONSerialization.data(withJSONObject: request),
              var requestLine = String(data: requestData, encoding: .utf8)
        else {
            PerfTimer.log("refreshDevicePool: failed to serialize request")
            return RefreshDevicesResult(success: false, addedDevices: 0, totalDevices: 0, availableDevices: 0)
        }
        requestLine.append("\n")

        PerfTimer.log("refreshDevicePool: sending daemon request")
        let result = sendDaemonRequest(requestLine, timeoutSeconds: timeoutSeconds)
        guard let result = result,
              let success = result["success"] as? Bool, success,
              let resultData = result["result"] as? [String: Any]
        else {
            PerfTimer.log("refreshDevicePool: request failed")
            return RefreshDevicesResult(success: false, addedDevices: 0, totalDevices: 0, availableDevices: 0)
        }

        let addedDevices = resultData["addedDevices"] as? Int ?? 0
        let totalDevices = resultData["totalDevices"] as? Int ?? 0
        let availableDevices = resultData["availableDevices"] as? Int ?? 0

        PerfTimer.log("refreshDevicePool END: +\(addedDevices) devices, \(availableDevices)/\(totalDevices) available")
        return RefreshDevicesResult(
            success: true,
            addedDevices: addedDevices,
            totalDevices: totalDevices,
            availableDevices: availableDevices
        )
    }

    /// Copy a Unix socket path into `addr.sun_path` without overflowing the fixed
    /// buffer. `sun_path` is a fixed C array (104 bytes on Darwin); the previous
    /// unbounded `strcpy` overflowed the stack `sockaddr_un` for env-supplied
    /// paths longer than the buffer (issue #3625). Returns `false` (leaving `addr`
    /// unchanged) when the path plus its NUL terminator does not fit.
    static func setSocketPath(_ path: String, into addr: inout sockaddr_un) -> Bool {
        let capacity = MemoryLayout.size(ofValue: addr.sun_path)
        let bytes = Array(path.utf8)
        // Need room for the trailing NUL, so the path itself must be < capacity.
        guard bytes.count < capacity else { return false }
        withUnsafeMutablePointer(to: &addr.sun_path) { tuplePtr in
            tuplePtr.withMemoryRebound(to: CChar.self, capacity: capacity) { dst in
                for (i, byte) in bytes.enumerated() {
                    dst[i] = CChar(bitPattern: byte)
                }
                dst[bytes.count] = 0
            }
        }
        return true
    }

    private static func sendDaemonRequest(_ request: String, timeoutSeconds: TimeInterval) -> [String: Any]? {
        let socketFd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard socketFd >= 0 else {
            print("[AutoMobile] Failed to create socket")
            return nil
        }
        defer { Darwin.close(socketFd) }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        guard Self.setSocketPath(socketPath, into: &addr) else {
            print("[AutoMobile] Daemon socket path too long (\(socketPath.utf8.count) bytes): \(socketPath)")
            return nil
        }

        let connectResult = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPtr in
                Darwin.connect(socketFd, sockaddrPtr, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }

        guard connectResult == 0 else {
            print("[AutoMobile] Failed to connect to daemon socket: \(errno)")
            return nil
        }

        // Set socket timeout
        var tv = timeval(tv_sec: Int(timeoutSeconds), tv_usec: 0)
        setsockopt(socketFd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))

        guard let requestData = request.data(using: .utf8) else {
            return nil
        }
        let written = requestData.withUnsafeBytes { ptr in
            Darwin.write(socketFd, ptr.baseAddress, ptr.count)
        }
        guard written == requestData.count else {
            print("[AutoMobile] Failed to write request to socket")
            return nil
        }

        var buffer = Data()
        let readBuffer = UnsafeMutablePointer<UInt8>.allocate(capacity: 4096)
        defer { readBuffer.deallocate() }

        while true {
            let bytesRead = Darwin.read(socketFd, readBuffer, 4096)
            if bytesRead > 0 {
                buffer.append(readBuffer, count: bytesRead)
                if let responseStr = String(data: buffer, encoding: .utf8),
                   responseStr.contains("\n")
                {
                    let lines = responseStr.split(separator: "\n", maxSplits: 1)
                    if let firstLine = lines.first,
                       let lineData = String(firstLine).data(using: .utf8),
                       let json = try? JSONSerialization.jsonObject(with: lineData) as? [String: Any]
                    {
                        return json
                    }
                }
            } else {
                break
            }
        }

        print("[AutoMobile] Timeout or error waiting for daemon response")
        return nil
    }
}
