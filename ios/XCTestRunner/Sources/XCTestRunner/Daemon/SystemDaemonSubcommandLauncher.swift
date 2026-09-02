import Foundation

/// Production launcher: spawns the process, waits (bounded) on its termination, and maps the exit
/// status to a `DaemonSubcommandOutcome`. Stateless value type → `Sendable`.
struct SystemDaemonSubcommandLauncher: DaemonSubcommandLauncher, Sendable {
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
