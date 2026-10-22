import Foundation

/// Adapters must create files exclusively with O_NOFOLLOW and check directories with lstat/open.
/// The parent is app-owned, commits are serialized, and destination is a fresh library ID.
protocol PrototypeBundleCommitFileSystem {
    func assertRealDirectory(_ path: URL) throws
    func assertAbsent(_ path: URL) throws
    func makeStagingDirectory(parent: URL, mode: UInt16) throws -> URL
    func mkdir(_ path: URL, mode: UInt16) throws
    func writeExclusiveNoFollow(_ path: URL, bytes: Data) throws
    func rename(from: URL, to destination: URL) throws
    func remove(_ path: URL) throws
}

struct PrototypeBundleStorageFailure: Error {
    let code = "storage_failure"
    let message: String
    let cleanupMessage: String?
}

enum PrototypeBundleCommit {
    @discardableResult
    static func commit(
        _ bundle: PrototypeBundle,
        destination: URL,
        fileSystem: any PrototypeBundleCommitFileSystem
    )
        throws -> URL
    {
        var stage: URL?
        do {
            let destination = destination.standardizedFileURL
            let parent = destination.deletingLastPathComponent()
            try fileSystem.assertRealDirectory(parent)
            try fileSystem.assertAbsent(destination)
            let files = try PrototypeBundle.canonicalFiles(.init(
                spec: bundle.spec, assets: { bundle.assets[PrototypeBundleID($0)] },
                fonts: { bundle.fonts[PrototypeBundleID($0)] }
            ), requires: bundle.requires)
            let fresh = try fileSystem.makeStagingDirectory(parent: parent, mode: 0o700).standardizedFileURL
            guard fresh.deletingLastPathComponent().path == parent.path, fresh.path != destination.path else {
                throw PrototypeBundleStorageFailure(
                    message: "Staging must be a fresh sibling of destination",
                    cleanupMessage: nil
                )
            }
            stage = fresh
            try fileSystem.assertRealDirectory(fresh)
            for directory in ["assets", "fonts"] {
                let path = fresh.appendingPathComponent(directory)
                try fileSystem.mkdir(path, mode: 0o700)
                try fileSystem.assertRealDirectory(path)
            }
            for (path, bytes) in files {
                try fileSystem.writeExclusiveNoFollow(fresh.appendingPathComponent(path), bytes: bytes)
            }
            try fileSystem.assertRealDirectory(parent)
            try fileSystem.assertRealDirectory(fresh)
            try fileSystem.assertAbsent(destination)
            try fileSystem.rename(from: fresh, to: destination)
            return destination
        } catch {
            var cleanup: String?
            if let stage {
                do { try fileSystem.remove(stage) }
                catch { cleanup = String(describing: error) }
            }
            throw PrototypeBundleStorageFailure(message: String(describing: error), cleanupMessage: cleanup)
        }
    }
}
