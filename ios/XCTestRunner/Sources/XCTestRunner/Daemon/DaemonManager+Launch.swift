import Foundation

extension DaemonManager {
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
        case let .invalidPackageVersion(version):
            PerfTimer.log("runDaemonSubcommand: ERROR - invalid pinned daemon package version: \(version)")
            return .invalidPackageVersion(version)
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
            ?? 30_000
        let startupSeconds = configuredStartupMilliseconds > 0
            ? TimeInterval(configuredStartupMilliseconds) / 1000
            : 30
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
        switch daemonPackageVersionResolution(packageVersion) {
        case let .valid(packageSpecifier):
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
        case let .invalid(version):
            return .invalidPackageVersion(version)
        case .absent:
            break
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
}
