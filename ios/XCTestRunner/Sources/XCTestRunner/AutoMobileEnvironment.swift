import CryptoKit
import Darwin
import Foundation

struct AutoMobileEnvironment {
    private let values: [String: String]

    init(values: [String: String] = ProcessInfo.processInfo.environment) {
        self.values = values
    }

    func firstNonEmpty(_ keys: [String]) -> String? {
        for key in keys {
            if let value = values[key], !value.isEmpty {
                return value
            }
        }
        return nil
    }

    func intValue(_ keys: [String]) -> Int? {
        if let stringValue = firstNonEmpty(keys) {
            return Int(stringValue)
        }
        return nil
    }

    func doubleValue(_ keys: [String]) -> Double? {
        if let stringValue = firstNonEmpty(keys) {
            return Double(stringValue)
        }
        return nil
    }

    func boolValue(_ keys: [String]) -> Bool? {
        guard let value = firstNonEmpty(keys) else {
            return nil
        }
        return ["1", "true", "yes", "y"].contains(value.lowercased())
    }
}

enum AutoMobileDaemonSocket {
    static var defaultPath: String {
        let uid = String(getuid())
        return "/tmp/auto-mobile-daemon-\(uid).sock"
    }
}

enum SimulatorDetection {
    /// Check if any iOS simulator is currently booted (fast check)
    static func hasBootedSimulator() -> Bool {
        PerfTimer.log("hasBootedSimulator: starting xcrun simctl")
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
        process.arguments = ["simctl", "list", "devices", "booted", "--json"]

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice

        do {
            try process.run()
            PerfTimer.log("hasBootedSimulator: waiting for simctl to complete")
            process.waitUntilExit()

            guard process.terminationStatus == 0 else {
                PerfTimer.log("hasBootedSimulator: simctl failed with status \(process.terminationStatus)")
                return false
            }

            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            PerfTimer.log("hasBootedSimulator: parsing \(data.count) bytes of JSON")
            guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let devices = json["devices"] as? [String: [[String: Any]]]
            else {
                PerfTimer.log("hasBootedSimulator: failed to parse JSON")
                return false
            }

            var bootedCount = 0
            for (_, deviceList) in devices {
                bootedCount += deviceList.count
            }
            PerfTimer.log("hasBootedSimulator: found \(bootedCount) booted simulators")
            return bootedCount > 0
        } catch {
            PerfTimer.log("hasBootedSimulator: ERROR - \(error)")
            return false
        }
    }
}

public enum DaemonManager {
    public struct PidFileData: Decodable {
        public let pid: Int
        public let port: Int?
        public let socketPath: String?
        public let startedAt: Int64?
        public let version: String?
        public let entryScript: String?
        public let buildId: String?
    }

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

    public static func startDaemon(repoRoot: String? = nil) -> Bool {
        return runDaemonSubcommand("start", repoRoot: repoRoot)
    }

    /// Restart the daemon in place — used to replace a stale different-build daemon that owns
    /// the shared per-uid socket (#2744) so the runner self-heals instead of failing the
    /// version handshake. Mirrors the Android runner's PID-file version-skew restart.
    public static func restartDaemon(repoRoot: String? = nil) -> Bool {
        return runDaemonSubcommand("restart", repoRoot: repoRoot)
    }

    private static func runDaemonSubcommand(_ subcommand: String, repoRoot: String? = nil) -> Bool {
        // When a repo root with a built entrypoint is provided, launch *that* checkout's daemon
        // (`<repoRoot>/dist/src/index.js`) rather than whatever `auto-mobile` is on PATH — so a
        // caller that knows its source build gets a version/build-matched daemon (#2744) instead of
        // a same-release-but-different-checkout PATH binary. Falls back to the PATH binary otherwise.
        let executableURL: URL
        let arguments: [String]
        if let localEntry = resolveRepoRootDaemonEntryScript(repoRoot),
           let runtime = findExecutable("bun") ?? findExecutable("node")
        {
            PerfTimer.log("runDaemonSubcommand(\(subcommand)): launching local build at \(localEntry)")
            executableURL = URL(fileURLWithPath: runtime)
            arguments = [localEntry, "--daemon", subcommand]
        } else {
            PerfTimer.log("runDaemonSubcommand(\(subcommand)): searching for auto-mobile executable")
            guard let autoMobilePath = findExecutable("auto-mobile") else {
                PerfTimer.log("runDaemonSubcommand: ERROR - auto-mobile not found in PATH")
                return false
            }
            PerfTimer.log("runDaemonSubcommand: found auto-mobile at \(autoMobilePath)")
            executableURL = URL(fileURLWithPath: autoMobilePath)
            arguments = ["--daemon", subcommand]
        }

        let process = Process()
        process.executableURL = executableURL
        process.arguments = arguments

        // Inherit essential environment variables for device discovery
        var env = ProcessInfo.processInfo.environment
        // Ensure PATH includes /usr/bin for xcrun/simctl
        let currentPath = env["PATH"] ?? ""
        if !currentPath.contains("/usr/bin") {
            env["PATH"] = "/usr/bin:/usr/local/bin:\(currentPath)"
        }
        process.environment = env

        PerfTimer.log("runDaemonSubcommand: launching process with args: \(process.arguments ?? [])")
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice

        do {
            try process.run()
            PerfTimer.log("runDaemonSubcommand: process launched, waiting for exit")
            process.waitUntilExit()
            let status = process.terminationStatus
            PerfTimer.log("runDaemonSubcommand: process exited with status \(status)")
            return status == 0
        } catch {
            PerfTimer.log("runDaemonSubcommand: ERROR - failed to run process: \(error)")
            return false
        }
    }

    /// The daemon's recorded version from its PID file, trimmed, or nil when absent/unreadable.
    static func readDaemonVersionFromPidFile() -> String? {
        guard let data = FileManager.default.contents(atPath: pidFilePath),
              let pidData = try? JSONDecoder().decode(PidFileData.self, from: data),
              let version = pidData.version?.trimmingCharacters(in: .whitespaces),
              !version.isEmpty
        else {
            return nil
        }
        return version
    }

    /// The daemon's recorded entry-script path from its PID file, trimmed, or nil when absent.
    static func readDaemonEntryScriptFromPidFile() -> String? {
        guard let data = FileManager.default.contents(atPath: pidFilePath),
              let pidData = try? JSONDecoder().decode(PidFileData.self, from: data),
              let entryScript = pidData.entryScript?.trimmingCharacters(in: .whitespaces),
              !entryScript.isEmpty
        else {
            return nil
        }
        return entryScript
    }

    /// The daemon's recorded build-identity hash from its PID file, trimmed, or nil when absent.
    static func readDaemonBuildIdFromPidFile() -> String? {
        guard let data = FileManager.default.contents(atPath: pidFilePath),
              let pidData = try? JSONDecoder().decode(PidFileData.self, from: data),
              let buildId = pidData.buildId?.trimmingCharacters(in: .whitespaces),
              !buildId.isEmpty
        else {
            return nil
        }
        return buildId
    }

    /// Short content hash of an entry script (sha256, first 16 hex chars) — matches the daemon's
    /// `computeBuildIdentity`, so the value compares equal to the daemon's own recorded build id.
    static func computeBuildId(_ entryScript: String) -> String? {
        guard let data = FileManager.default.contents(atPath: entryScript) else {
            return nil
        }
        let hex = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        return String(hex.prefix(16))
    }

    /// When a caller supplies a repo root with a built entrypoint, whether the running daemon was
    /// started from a *different* build (#2744). Prefers comparing the entry-script content hash
    /// against the daemon's recorded `buildId` — this catches the same repoRoot path rebuilt or
    /// checked out to another commit — and falls back to comparing entry-script paths when a hash is
    /// unavailable. No-op without a repoRoot build or when neither signal is available.
    static func requiresRepoRootBuildSkew(
        daemonBuildId: String?,
        daemonEntryScript: String?,
        repoRoot: String?
    )
        -> Bool
    {
        guard let expectedEntry = resolveRepoRootDaemonEntryScript(repoRoot) else {
            return false
        }
        let expectedHash = computeBuildId(expectedEntry)
        let daemonHash = daemonBuildId?.trimmingCharacters(in: .whitespaces)
        if let expectedHash = expectedHash,
           let daemonHash = daemonHash, !daemonHash.isEmpty, daemonHash != "unknown"
        {
            return daemonHash != expectedHash
        }
        guard let daemonEntry = daemonEntryScript?.trimmingCharacters(in: .whitespaces), !daemonEntry.isEmpty else {
            return false
        }
        return daemonEntry != expectedEntry
    }

    /// The release portion of a version string — everything before the `+g<sha>` dev stamp.
    /// Mirrors the daemon's `releaseVersion`, so a git-stamped source-checkout daemon compares
    /// equal to this runner's plain release.
    static func releaseVersion(_ version: String) -> String {
        return String(version.split(separator: "+", maxSplits: 1, omittingEmptySubsequences: false)
            .first ?? Substring(version))
    }

    /// Whether an already-running daemon must be restarted before reuse because its recorded
    /// version does not match this runner's (#2744). Compares release portions; a blank/unknown
    /// version on either side yields false so an unidentifiable daemon is not thrashed.
    static func requiresVersionSkewRestart(daemonVersion: String?, clientVersion: String) -> Bool {
        guard let daemonVersion = daemonVersion?.trimmingCharacters(in: .whitespaces), !daemonVersion.isEmpty else {
            return false
        }
        let client = clientVersion.trimmingCharacters(in: .whitespaces)
        if client.isEmpty {
            return false
        }
        return releaseVersion(daemonVersion) != releaseVersion(client)
    }

    public static func ensureDaemonRunning(repoRoot: String? = nil, timeoutSeconds: TimeInterval = 15) -> Bool {
        PerfTimer.log("ensureDaemonRunning: checking isDaemonRunning")
        if isDaemonRunning() {
            // A stale different-build daemon on the shared socket would reject this runner's
            // version handshake (#2744). Restart it before reuse so we self-heal instead of
            // failing, mirroring the Android/TS version-skew restart. When a repoRoot is supplied,
            // also restart a same-release daemon started from a different checkout's entry script.
            let versionSkew = requiresVersionSkewRestart(
                daemonVersion: readDaemonVersionFromPidFile(),
                clientVersion: AutoMobileVersion.current
            )
            if versionSkew || requiresRepoRootBuildSkew(
                daemonBuildId: readDaemonBuildIdFromPidFile(),
                daemonEntryScript: readDaemonEntryScriptFromPidFile(),
                repoRoot: repoRoot
            ) {
                PerfTimer.log("ensureDaemonRunning: daemon version/build skew, restarting")
                guard restartDaemon(repoRoot: repoRoot) else {
                    PerfTimer.log("ensureDaemonRunning: restartDaemon failed")
                    return false
                }
                return waitForVersionMatchedDaemon(repoRoot: repoRoot, timeoutSeconds: timeoutSeconds)
            }
            PerfTimer.log("ensureDaemonRunning: daemon already running")
            return true
        }

        PerfTimer.log("ensureDaemonRunning: starting daemon")
        guard startDaemon(repoRoot: repoRoot) else {
            PerfTimer.log("ensureDaemonRunning: startDaemon failed")
            return false
        }

        return waitForVersionMatchedDaemon(repoRoot: repoRoot, timeoutSeconds: timeoutSeconds)
    }

    /// Wait for the daemon to become ready and confirm its recorded version matches this runner's.
    /// `start`/`restart` launch whatever `auto-mobile` is on PATH — which may be a different version
    /// than this runner's baked `AutoMobileVersion.current` — and `waitForDaemon` only checks
    /// pid/socket liveness, so without this a wrong-version daemon would look "ready" while its
    /// handshake gate (#2744) rejects every subsequent request. A daemon that records no version is
    /// accepted (a skew cannot be proven), matching the gate's lenient stance.
    private static func waitForVersionMatchedDaemon(repoRoot: String?, timeoutSeconds: TimeInterval) -> Bool {
        PerfTimer.log("ensureDaemonRunning: waiting for daemon")
        guard waitForDaemon(timeoutSeconds: timeoutSeconds) else {
            return false
        }
        if requiresVersionSkewRestart(
            daemonVersion: readDaemonVersionFromPidFile(),
            clientVersion: AutoMobileVersion.current
        ) || requiresRepoRootBuildSkew(
            daemonBuildId: readDaemonBuildIdFromPidFile(),
            daemonEntryScript: readDaemonEntryScriptFromPidFile(),
            repoRoot: repoRoot
        ) {
            PerfTimer.log("ensureDaemonRunning: daemon still differs from runner after launch")
            return false
        }
        return true
    }

    public static func waitForDaemon(timeoutSeconds: TimeInterval) -> Bool {
        PerfTimer.log("waitForDaemon: timeout=\(timeoutSeconds)s")
        let deadline = Date().addingTimeInterval(timeoutSeconds)
        var pollCount = 0
        while Date() < deadline {
            pollCount += 1
            if isDaemonRunning() && FileManager.default.fileExists(atPath: socketPath) {
                PerfTimer.log("waitForDaemon: ready after \(pollCount) polls")
                return true
            }
            Thread.sleep(forTimeInterval: 0.2)
        }
        PerfTimer.log("waitForDaemon: TIMEOUT after \(pollCount) polls")
        return false
    }

    /// Resolve the built daemon entrypoint under a caller-provided repo root, or nil when no root
    /// is given or the build is absent (so the caller falls back to the PATH `auto-mobile`).
    static func resolveRepoRootDaemonEntryScript(_ repoRoot: String?) -> String? {
        guard let repoRoot = repoRoot, !repoRoot.isEmpty else {
            return nil
        }
        let entry = URL(fileURLWithPath: repoRoot)
            .appendingPathComponent("dist/src/index.js").path
        return FileManager.default.fileExists(atPath: entry) ? entry : nil
    }

    private static func findExecutable(_ name: String) -> String? {
        let commonPaths = [
            "/usr/local/bin/\(name)",
            "/opt/homebrew/bin/\(name)",
            "/usr/bin/\(name)",
            "\(NSHomeDirectory())/.bun/bin/\(name)",
            "\(NSHomeDirectory())/.local/bin/\(name)",
        ]
        for path in commonPaths {
            if FileManager.default.isExecutableFile(atPath: path) {
                return path
            }
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

    public struct RefreshDevicesResult {
        public let success: Bool
        public let addedDevices: Int
        public let totalDevices: Int
        public let availableDevices: Int
    }

    public static func releaseSession(_ sessionId: String) -> Bool {
        guard isDaemonRunning() else {
            print("[AutoMobile] Cannot release session: daemon not running")
            return false
        }

        let requestId = UUID().uuidString
        let request: [String: Any] = [
            "id": requestId,
            "type": "daemon_request",
            "method": "daemon/releaseSession",
            "params": ["sessionId": sessionId],
            // Declared for the daemon's server-side version handshake gate (#2744).
            "clientVersion": AutoMobileVersion.current,
        ]

        guard let requestData = try? JSONSerialization.data(withJSONObject: request),
              var requestLine = String(data: requestData, encoding: .utf8)
        else {
            print("[AutoMobile] Failed to serialize release session request")
            return false
        }
        requestLine.append("\n")

        let result = sendDaemonRequest(requestLine, timeoutSeconds: 5)
        if let result = result, let success = result["success"] as? Bool, success {
            if let resultData = result["result"] as? [String: Any],
               let alreadyReleased = resultData["alreadyReleased"] as? Bool,
               alreadyReleased
            {
                print("[AutoMobile] Session \(sessionId) was already released (auto-released by daemon)")
            } else {
                print("[AutoMobile] Session \(sessionId) released")
            }
            return true
        }
        if let result = result, let error = result["error"] as? String {
            print("[AutoMobile] Failed to release session \(sessionId): \(error)")
        } else {
            print("[AutoMobile] Failed to release session \(sessionId)")
        }
        return false
    }

    public static func refreshDevicePool(timeoutSeconds: TimeInterval = 30) -> RefreshDevicesResult {
        PerfTimer.log("refreshDevicePool START")
        guard isDaemonRunning() else {
            PerfTimer.log("refreshDevicePool: daemon not running")
            return RefreshDevicesResult(success: false, addedDevices: 0, totalDevices: 0, availableDevices: 0)
        }

        let requestId = UUID().uuidString
        let request: [String: Any] = [
            "id": requestId,
            "type": "daemon_request",
            "method": "daemon/refreshDevices",
            "params": [String: Any](),
            // Declared for the daemon's server-side version handshake gate (#2744).
            "clientVersion": AutoMobileVersion.current,
        ]

        guard let requestData = try? JSONSerialization.data(withJSONObject: request),
              var requestLine = String(data: requestData, encoding: .utf8)
        else {
            PerfTimer.log("refreshDevicePool: failed to serialize request")
            return RefreshDevicesResult(success: false, addedDevices: 0, totalDevices: 0, availableDevices: 0)
        }
        requestLine.append("\n")

        PerfTimer.log("refreshDevicePool: sending daemon request")
        let result = sendDaemonRequest(requestLine, timeoutSeconds: timeoutSeconds)
        guard let result = result,
              let success = result["success"] as? Bool, success,
              let resultData = result["result"] as? [String: Any]
        else {
            PerfTimer.log("refreshDevicePool: request failed")
            return RefreshDevicesResult(success: false, addedDevices: 0, totalDevices: 0, availableDevices: 0)
        }

        let addedDevices = resultData["addedDevices"] as? Int ?? 0
        let totalDevices = resultData["totalDevices"] as? Int ?? 0
        let availableDevices = resultData["availableDevices"] as? Int ?? 0

        PerfTimer.log("refreshDevicePool END: +\(addedDevices) devices, \(availableDevices)/\(totalDevices) available")
        return RefreshDevicesResult(
            success: true,
            addedDevices: addedDevices,
            totalDevices: totalDevices,
            availableDevices: availableDevices
        )
    }

    private static func sendDaemonRequest(_ request: String, timeoutSeconds: TimeInterval) -> [String: Any]? {
        let socketFd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard socketFd >= 0 else {
            print("[AutoMobile] Failed to create socket")
            return nil
        }
        defer { Darwin.close(socketFd) }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        socketPath.withCString { cString in
            _ = withUnsafeMutablePointer(to: &addr.sun_path.0) { ptr in
                strcpy(ptr, cString)
            }
        }

        let connectResult = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPtr in
                Darwin.connect(socketFd, sockaddrPtr, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }

        guard connectResult == 0 else {
            print("[AutoMobile] Failed to connect to daemon socket: \(errno)")
            return nil
        }

        // Set socket timeout
        var tv = timeval(tv_sec: Int(timeoutSeconds), tv_usec: 0)
        setsockopt(socketFd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))

        guard let requestData = request.data(using: .utf8) else {
            return nil
        }
        let written = requestData.withUnsafeBytes { ptr in
            Darwin.write(socketFd, ptr.baseAddress, ptr.count)
        }
        guard written == requestData.count else {
            print("[AutoMobile] Failed to write request to socket")
            return nil
        }

        var buffer = Data()
        let readBuffer = UnsafeMutablePointer<UInt8>.allocate(capacity: 4096)
        defer { readBuffer.deallocate() }

        while true {
            let bytesRead = Darwin.read(socketFd, readBuffer, 4096)
            if bytesRead > 0 {
                buffer.append(readBuffer, count: bytesRead)
                if let responseStr = String(data: buffer, encoding: .utf8),
                   responseStr.contains("\n")
                {
                    let lines = responseStr.split(separator: "\n", maxSplits: 1)
                    if let firstLine = lines.first,
                       let lineData = String(firstLine).data(using: .utf8),
                       let json = try? JSONSerialization.jsonObject(with: lineData) as? [String: Any]
                    {
                        return json
                    }
                }
            } else {
                break
            }
        }

        print("[AutoMobile] Timeout or error waiting for daemon response")
        return nil
    }
}
