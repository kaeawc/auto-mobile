import Foundation

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
    ) -> DaemonSubcommandOutcome
    func waitForDaemon(timeoutSeconds: TimeInterval) -> Bool
}
