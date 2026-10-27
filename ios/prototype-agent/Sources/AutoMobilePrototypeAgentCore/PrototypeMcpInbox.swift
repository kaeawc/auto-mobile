import Foundation

/// A pushed bundle or result this old belongs to a request whose host gave up long ago (hosts wait
/// seconds): a result written after the host's timeout already removed its own copy, or a stray push.
let prototypeMcpOrphanMaxAge: TimeInterval = 10 * 60

/// Serializes whole MCP attempts. No store crosses executors; closures construct it on this actor.
actor PrototypeMcpInbox {
    private let root: URL
    private let files: any PrototypeLibraryFileSystem
    private let importBundle: @Sendable (URL, String?) throws -> PrototypeLibraryEntry
    private let entries: @Sendable () throws -> [PrototypeLibraryEntry]
    private let warning: @Sendable (String) -> Void
    private let now: @Sendable () -> Date
    private var pending: [String: String] = [:]

    init(
        root: URL,
        makeFiles: @Sendable () -> any PrototypeLibraryFileSystem = { PrototypeLibraryDiskFileSystem() },
        importBundle: @escaping @Sendable (URL, String?) throws -> PrototypeLibraryEntry,
        entries: @escaping @Sendable () throws -> [PrototypeLibraryEntry],
        now: @escaping @Sendable () -> Date = { Date() },
        warning: @escaping @Sendable (String) -> Void
    ) {
        self.root = root
        self.now = now
        files = makeFiles()
        self.importBundle = importBundle
        self.entries = entries
        self.warning = warning
    }

    init(
        root: URL, libraryRoot: URL, storageRoot: URL, now: @escaping @Sendable () -> Date = { Date() },
        warning: @escaping @Sendable (String) -> Void
    ) {
        self.root = root
        self.now = now
        files = PrototypeLibraryDiskFileSystem()
        importBundle = { url, label in
            let bytes = try PrototypeLibraryFileReader().read(url)
            let store = try PrototypeLibraryStore(root: libraryRoot, storageRoot: storageRoot)
            return try PrototypeLibraryImporter(store: store).importData(bytes, source: .mcp, label: label)
        }
        entries = { try PrototypeLibraryStore(root: libraryRoot, storageRoot: storageRoot).list().entries }
        self.warning = warning
    }

    func ensureDirectories() throws {
        try files.createDirectory(root.appendingPathComponent("inbox", isDirectory: true))
        try files.createDirectory(root.appendingPathComponent("results", isDirectory: true))
    }

    /// Deletes regular files in `inbox` and `results` not modified for [prototypeMcpOrphanMaxAge].
    /// Best effort: a failure warns and the rest still goes. Folders, fresh files and files whose
    /// age is unknown are kept. Returns how many files were removed.
    @discardableResult
    func sweepOrphans() -> Int {
        let cutoff = now().addingTimeInterval(-prototypeMcpOrphanMaxAge)
        var removed = 0
        for folder in ["inbox", "results"] {
            let directory = root.appendingPathComponent(folder, isDirectory: true)
            guard files.exists(directory), let names = try? files.children(directory) else { continue }
            for name in names {
                let url = directory.appendingPathComponent(name)
                guard let modified = files.modifiedAt(url), modified < cutoff else { continue }
                do { try files.remove(url); removed += 1 }
                catch { warning("MCP orphan sweep could not remove a file: \(error.localizedDescription)") }
            }
        }
        return removed
    }

    /// A found open waits for the UI's load callback before reporting success.
    func handle(_ command: PrototypeMcpRequest) -> PrototypeLibraryEntry? {
        sweepOrphans()
        guard PrototypeMcpRequest.validRequestId(command.request),
              !files.exists(resultURL(command.request)), pending[command.request] == nil
        else { return nil }
        switch command {
        case let .unsupported(request, reason): write(.rejected(request, path: "action", reason: reason))
        case let .importBundle(request, label): write(importResult(request, label: label))
        case let .open(request, libraryId):
            guard (try? PrototypeLibraryEntry.validateId(libraryId)) != nil else {
                write(.init(status: "not_found", request: request)); return nil
            }
            do {
                guard let entry = try entries().first(where: { $0.libraryId == libraryId }) else {
                    write(.init(status: "not_found", request: request)); return nil
                }
                pending[request] = libraryId
                return entry
            } catch {
                write(.rejected(request, path: "library", reason: "Unable to read the prototype library"))
            }
        }
        return nil
    }

    func reportOpened(_ command: PrototypeMcpRequest, entry: PrototypeLibraryEntry) {
        guard pending[command.request] == entry.libraryId else { return }
        pending.removeValue(forKey: command.request)
        write(.entry("opened", request: command.request, entry: entry))
    }

    func reportOpenFailed(_ command: PrototypeMcpRequest) {
        guard pending.removeValue(forKey: command.request) != nil else { return }
        write(.rejected(command.request, path: "viewer", reason: "Unable to open the prototype"))
    }

    private func importResult(_ request: String, label: String?) -> WireResult {
        let inbox = root.appendingPathComponent("inbox", isDirectory: true)
        let url = inbox.appendingPathComponent("\(request).automobile-proto")
        defer {
            do { try PrototypeLibraryInbox(root: inbox, files: files).cleanup(url) }
            catch { warning("MCP inbox cleanup failed: \(error.localizedDescription)") }
        }
        let label = label?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let label, !PrototypeMcpRequest.validLabel(label) {
            return .rejected(request, path: "label", reason: "Use a label of 1 to 120 characters on one line")
        }
        guard files.exists(url) else {
            return .rejected(request, path: "inbox", reason: "No pushed prototype for this request")
        }
        do { return try .entry("imported", request: request, entry: importBundle(url, label)) }
        catch let failure as PrototypeLibraryImportFailure {
            switch failure {
            case .needsNewerViewer: return .rejected(request, path: "capability", reason: failure.message)
            case .invalid:
                return .rejected(
                    request, path: failure.message == "Import byte cap exceeded" ? "content" : failure.path,
                    reason: failure.message
                )
            }
        } catch let failure as PrototypeLibraryFailure {
            return .rejected(request, path: failure.path, reason: failure.message)
        } catch {
            warning("MCP import could not read its inbox file")
            return .rejected(request, path: "inbox", reason: "Unable to read the pushed prototype")
        }
    }

    private func resultURL(_ request: String) -> URL {
        root.appendingPathComponent("results", isDirectory: true).appendingPathComponent("\(request).json")
    }

    private func write(_ result: WireResult) {
        do {
            try files.createDirectory(root.appendingPathComponent("results", isDirectory: true))
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys]
            try files.writeAtomic(resultURL(result.request), bytes: encoder.encode(result))
            if result.status == "rejected" { warning("MCP request rejected at \(result.path ?? "action")") }
        } catch { warning("Cannot publish MCP result: \(error.localizedDescription)") }
    }

    private struct WireResult: Encodable {
        let status: String
        let request: String
        var libraryId: String?
        var label: String?
        var path: String?
        var reason: String?

        static func entry(_ status: String, request: String, entry: PrototypeLibraryEntry) -> Self {
            Self(status: status, request: request, libraryId: entry.libraryId, label: entry.label)
        }

        static func rejected(_ request: String, path: String, reason: String) -> Self {
            Self(status: "rejected", request: request, path: path, reason: reason)
        }
    }
}
