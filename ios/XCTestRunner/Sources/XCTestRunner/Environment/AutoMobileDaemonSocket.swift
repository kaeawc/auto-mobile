import CryptoKit
import Darwin
import Foundation

/// The daemon's per-uid control socket. Frozen wire contract shared with the TypeScript daemon
/// (`src/daemon/constants.ts`): `/tmp/auto-mobile-daemon-<uid><suffix>.sock`, where the suffix
/// isolates an `AUTOMOBILE_AUX_SOCKET_DIR` daemon and an explicit `AUTOMOBILE_DAEMON_SOCKET_PATH`
/// wins over both.
enum AutoMobileDaemonSocket {
    static var defaultPath: String {
        DaemonStatePaths.resolve(.socket, environment: ProcessInfo.processInfo.environment)
    }
}

/// A daemon state file under `/tmp`, with the env vars that override its path.
enum DaemonStateFile: Sendable {
    case socket
    case pid

    var fileExtension: String {
        switch self {
        case .socket: return "sock"
        case .pid: return "pid"
        }
    }

    var overrideKeys: [String] {
        switch self {
        case .socket: return ["AUTOMOBILE_DAEMON_SOCKET_PATH", "AUTO_MOBILE_DAEMON_SOCKET_PATH"]
        case .pid: return ["AUTOMOBILE_DAEMON_PID_FILE_PATH", "AUTO_MOBILE_DAEMON_PID_FILE_PATH"]
        }
    }
}

/// Port of `resolveDaemonStatePath` (`src/daemon/constants.ts`): an explicit
/// `AUTOMOBILE_DAEMON_*_PATH` override (resolved against the daemon launch directory) first, then
/// `/tmp/auto-mobile-daemon-<uid><suffix>.<ext>`. The runner launches the daemon with its own
/// environment, so it must resolve the same paths that daemon uses (#10906). Tested against the
/// shared vectors in `test/fixtures/daemon-isolation-paths.json`.
enum DaemonStatePaths {
    private static let isolationHashHexChars = 10

    static func resolve(
        _ file: DaemonStateFile,
        environment: [String: String],
        userId: () -> String = { String(getuid()) },
        currentDirectory: String = FileManager.default.currentDirectoryPath
    )
        -> String
    {
        let override = file.overrideKeys.lazy.compactMap { environment[$0] }.first?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !override.isEmpty {
            return resolveFromDaemonLaunchDirectory(
                override, environment: environment, currentDirectory: currentDirectory
            )
        }
        let suffix = isolationSuffix(environment: environment, currentDirectory: currentDirectory)
        return "/tmp/auto-mobile-daemon-\(userId())\(suffix).\(file.fileExtension)"
    }

    /// `-<first 10 hex chars of sha256(resolved aux dir)>`, or "" without an aux dir.
    static func isolationSuffix(
        environment: [String: String],
        currentDirectory: String = FileManager.default.currentDirectoryPath
    )
        -> String
    {
        let auxDir = environment["AUTOMOBILE_AUX_SOCKET_DIR"]?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !auxDir.isEmpty else { return "" }
        let resolved = resolveFromDaemonLaunchDirectory(
            auxDir, environment: environment, currentDirectory: currentDirectory
        )
        let hex = SHA256.hash(data: Data(resolved.utf8)).map { String(format: "%02x", $0) }.joined()
        return "-" + hex.prefix(isolationHashHexChars)
    }

    /// Mirrors `resolvePathFromDaemonLaunchWorkingDirectory`: an absolute path is kept verbatim, a
    /// relative one is resolved (and normalized) against an absolute `AUTOMOBILE_DAEMON_LAUNCH_CWD`,
    /// else `currentDirectory`.
    private static func resolveFromDaemonLaunchDirectory(
        _ path: String,
        environment: [String: String],
        currentDirectory: String
    )
        -> String
    {
        if path.hasPrefix("/") {
            return path
        }
        let launchDirectory = environment["AUTOMOBILE_DAEMON_LAUNCH_CWD"]?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let base = launchDirectory.flatMap { $0.hasPrefix("/") ? $0 : nil } ?? currentDirectory
        return normalizeAbsolutePath(base + "/" + path)
    }

    /// Lexical normalization like Node's `path.resolve`: drops empty and `.` segments and applies
    /// `..` without touching the filesystem (no symlink resolution).
    private static func normalizeAbsolutePath(_ path: String) -> String {
        var segments: [Substring] = []
        for segment in path.split(separator: "/", omittingEmptySubsequences: true) {
            switch segment {
            case ".":
                continue
            case "..":
                _ = segments.popLast()
            default:
                segments.append(segment)
            }
        }
        return "/" + segments.joined(separator: "/")
    }
}
