import Foundation
import Network

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
    )
        -> DaemonSubcommandOutcome
    {
        DaemonManager.runDaemonSubcommand(
            subcommand,
            repoRoot: repoRoot,
            timeoutSeconds: timeoutSeconds
        )
    }

    func waitForDaemon(timeoutSeconds: TimeInterval) -> Bool {
        DaemonManager.waitForDaemon(timeoutSeconds: timeoutSeconds, connector: SystemDaemonSocketConnector())
    }
}

struct SystemDaemonSocketConnector: DaemonSocketConnector {
    func connectAndClose(socketPath: String, timeout: TimeInterval) -> Bool {
        let connection = NWConnection(to: .unix(path: socketPath), using: .tcp)
        let semaphore = DispatchSemaphore(value: 0)
        let result = ConnectionProbeResult()
        connection.stateUpdateHandler = { state in
            switch state {
            case .ready:
                result.connected = true
                semaphore.signal()
            case .failed, .cancelled:
                semaphore.signal()
            default:
                break
            }
        }
        connection.start(queue: DispatchQueue.global(qos: .utility))
        _ = semaphore.wait(timeout: .now() + timeout)
        connection.cancel()
        return result.connected
    }
}

private final class ConnectionProbeResult: @unchecked Sendable {
    var connected = false
}
