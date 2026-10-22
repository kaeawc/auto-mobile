import Foundation

/// An actor serializes complete import attempts away from the UI executor. No store or fake
/// crosses executors: the Sendable operations construct their dependencies on this actor.
actor PrototypeLibraryImportService {
    typealias Source = PrototypeLibraryImporter.Source
    private let read: @Sendable (URL) throws -> Data
    private let commit: @Sendable (Data, Source) throws -> Void
    private let cleanup: @Sendable (URL) throws -> Void
    private let warning: @Sendable (String) -> Void
    private let checkCancellation: @Sendable () throws -> Void

    init(
        read: @escaping @Sendable (URL) throws -> Data,
        commit: @escaping @Sendable (Data, Source) throws -> Void,
        cleanup: @escaping @Sendable (URL) throws -> Void,
        warning: @escaping @Sendable (String) -> Void,
        checkCancellation: @escaping @Sendable () throws -> Void = { try Task.checkCancellation() }
    ) {
        self.read = read
        self.commit = commit
        self.cleanup = cleanup
        self.warning = warning
        self.checkCancellation = checkCancellation
    }

    init(root: URL, storageRoot: URL, inbox: URL, warning: @escaping @Sendable (String) -> Void) {
        read = { try PrototypeLibraryFileReader().read($0) }
        commit = { bytes, source in
            let store = try PrototypeLibraryStore(root: root, storageRoot: storageRoot)
            try PrototypeLibraryImporter(store: store).importData(bytes, source: source)
        }
        cleanup = { try PrototypeLibraryInbox(root: inbox).cleanup($0) }
        self.warning = warning
        checkCancellation = { try Task.checkCancellation() }
    }

    func importFile(_ url: URL, source: Source) throws {
        defer {
            do { try cleanup(url) }
            catch { warning("Inbox cleanup failed: \(error.localizedDescription)") }
        }
        try checkCancellation()
        let bytes = try read(url)
        try checkCancellation()
        try commit(bytes, source)
    }
}
