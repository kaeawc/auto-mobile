import Foundation

/// The daemon's HTTP port as published in its PID file. Re-read for every HTTP exchange because a
/// restarted daemon may listen on a new port. `nil` means the port is unverifiable.
protocol DaemonHTTPPortDiscovering: Sendable {
    func discoveredPort() -> Int?
}

/// Mirrors the token discovery: the isolation-aware PID file path (`DaemonStatePaths`) and the
/// existing `DaemonManager.PidFileData` decoding. The file read is injected so unit tests never
/// touch host state. Discovery is best effort, with a fixed log message that never contains a path
/// or read error.
struct DaemonPidFilePortDiscovery: DaemonHTTPPortDiscovering {
    var environment: @Sendable () -> [String: String] = { ProcessInfo.processInfo.environment }
    var currentDirectory: @Sendable () -> String = { FileManager.default.currentDirectoryPath }
    var userId: @Sendable () -> uid_t = { getuid() }
    var readFile: @Sendable (String) -> Data? = { FileManager.default.contents(atPath: $0) }
    var logger: any AutoMobileLogger = StdoutLogger()

    func discoveredPort() -> Int? {
        let uid = userId()
        let path = DaemonStatePaths.resolve(
            .pid, environment: environment(), userId: { String(uid) }, currentDirectory: currentDirectory()
        )
        guard !path.contains("\0"), let data = readFile(path),
              let port = (try? JSONDecoder().decode(DaemonManager.PidFileData.self, from: data))?.port
        else {
            logger.info("Daemon HTTP port unavailable")
            return nil
        }
        return port
    }
}
