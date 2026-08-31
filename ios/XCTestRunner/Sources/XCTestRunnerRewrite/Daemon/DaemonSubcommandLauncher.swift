import Foundation

/// Injectable subprocess boundary so launcher timeouts are deterministic in unit tests.
protocol DaemonSubcommandLauncher {
    func launch(
        executable: String,
        arguments: [String],
        environment: [String: String],
        timeoutSeconds: TimeInterval
    ) -> DaemonSubcommandOutcome
}
