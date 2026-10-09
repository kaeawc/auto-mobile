import Darwin
import Foundation

/// Namespace for AutoMobile daemon lifecycle: readiness, version/build-skew reconciliation, launching,
/// and the raw per-uid socket client. A caseless enum with NO mutable static state — every `static var`
/// is a pure computed getter — so it is trivially concurrency-safe under strict concurrency. Its
/// methods are split by concern across `DaemonManager+*.swift` extensions.
public enum DaemonManager {
    /// The npm package name used for pinned daemon launches and repo-root discovery. Frozen contract.
    static let packageName = "@kaeawc/auto-mobile"

    /// Resolved like the daemon itself: explicit override, then the `AUTOMOBILE_AUX_SOCKET_DIR`
    /// isolation suffix, then `/tmp/auto-mobile-daemon-<uid>.pid` (#10906).
    public static var pidFilePath: String {
        DaemonStatePaths.resolve(.pid, environment: ProcessInfo.processInfo.environment)
    }

    public static var socketPath: String {
        DaemonStatePaths.resolve(.socket, environment: ProcessInfo.processInfo.environment)
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
        guard pid > 0, let processId = Int32(exactly: pid) else { return false }
        return kill(processId, 0) == 0
    }
}
