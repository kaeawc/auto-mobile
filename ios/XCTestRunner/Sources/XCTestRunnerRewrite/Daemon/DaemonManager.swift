import Darwin
import Foundation

/// Namespace for AutoMobile daemon lifecycle: readiness, version/build-skew reconciliation, launching,
/// and the raw per-uid socket client. A caseless enum with NO mutable static state — every `static var`
/// is a pure computed getter — so it is trivially concurrency-safe under strict concurrency. Its
/// methods are split by concern across `DaemonManager+*.swift` extensions.
public enum DaemonManager {
    /// The npm package name used for pinned daemon launches and repo-root discovery. Frozen contract.
    static let packageName = "@kaeawc/auto-mobile"

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
}
