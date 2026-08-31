import Foundation

/// Production `DaemonRuntime` that reads the real PID file and spawns real subprocesses via
/// `DaemonManager`. Stateless value type → `Sendable`.
struct SystemDaemonRuntime: DaemonRuntime, Sendable {
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
