import Foundation

extension DaemonManager {
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
        case let .invalidPackageVersion(version):
            return .invalidPackageVersion(version)
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
        let hasLocalBuild = resolveRepoRootDaemonEntryScript(effectiveRepoRoot) != nil
        if !hasLocalBuild,
           case let .invalid(version) = daemonPackageVersionResolution(
               resolveDaemonPackageVersion(environment: environment)
           )
        {
            PerfTimer.log("ensureDaemonRunning: invalid pinned daemon package version: \(version)")
            return .invalidPackageVersion(version)
        }
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
}
