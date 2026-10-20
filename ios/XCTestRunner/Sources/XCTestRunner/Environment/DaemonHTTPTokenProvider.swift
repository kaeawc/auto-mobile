import Darwin
import Foundation

/// Re-read for every HTTP exchange so daemon restarts can rotate the per-daemon token.
protocol DaemonHTTPTokenProviding: Sendable {
    func readToken() -> String?
}

/// The descriptor operations are injected so unit tests never read host state files.
protocol DaemonTokenFileAccessing: Sendable {
    func metadata(path: String) -> stat?
    func open(path: String, flags: Int32) -> Int32
    func metadata(descriptor: Int32) -> stat?
    func read(descriptor: Int32) -> Data?
    func close(descriptor: Int32)
}

struct SystemDaemonTokenFileAccess: DaemonTokenFileAccessing {
    func metadata(path: String) -> stat? {
        var value = stat()
        return lstat(path, &value) == 0 ? value : nil
    }

    func open(path: String, flags: Int32) -> Int32 {
        Darwin.open(path, flags)
    }

    func metadata(descriptor: Int32) -> stat? {
        var value = stat()
        return fstat(descriptor, &value) == 0 ? value : nil
    }

    func read(descriptor: Int32) -> Data? {
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: false)
        return try? handle.readToEnd()
    }

    func close(descriptor: Int32) {
        _ = Darwin.close(descriptor)
    }
}

/// Mirrors `readDaemonHttpToken`: env first, then the isolated daemon state file. Discovery is
/// best effort, with fixed log messages that never contain a token, header, path, or read error.
struct DaemonHTTPTokenProvider: DaemonHTTPTokenProviding {
    var environment: @Sendable () -> [String: String] = { ProcessInfo.processInfo.environment }
    var currentDirectory: @Sendable () -> String = { FileManager.default.currentDirectoryPath }
    var userId: @Sendable () -> uid_t = { getuid() }
    var files: any DaemonTokenFileAccessing = SystemDaemonTokenFileAccess()
    var logger: any AutoMobileLogger = StdoutLogger()

    func readToken() -> String? {
        let environment = environment()
        if let token = trimmed(environment["AUTOMOBILE_DAEMON_HTTP_TOKEN"]) { return token }
        let uid = userId()
        let path = DaemonStatePaths.resolve(
            .token, environment: environment, userId: { String(uid) }, currentDirectory: currentDirectory()
        )
        guard !path.contains("\0"), let metadata = files.metadata(path: path),
              metadata.st_mode & S_IFMT == S_IFREG
        else { return unavailable() }
        // O_NONBLOCK also prevents a replaced non-regular file from blocking before fstat.
        let descriptor = files.open(path: path, flags: O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard descriptor >= 0 else { return unavailable() }
        defer { files.close(descriptor: descriptor) }
        // Validate the opened inode, including permissions; the path may have changed since lstat.
        guard let opened = files.metadata(descriptor: descriptor),
              opened.st_mode & S_IFMT == S_IFREG,
              opened.st_uid == uid, opened.st_mode & 0o7777 == 0o600,
              let data = files.read(descriptor: descriptor),
              let token = trimmed(String(data: data, encoding: .utf8))
        else { return unavailable() }
        return token
    }

    private func trimmed(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
        return value
    }

    private func unavailable() -> String? {
        logger.info("Daemon HTTP token unavailable")
        return nil
    }
}
