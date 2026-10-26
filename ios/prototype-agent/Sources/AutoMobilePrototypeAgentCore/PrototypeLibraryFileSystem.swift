import Foundation

/// App-owned directories, bounded regular-file reads, and same-volume atomic commits.
protocol PrototypeLibraryFileSystem: PrototypeBundleCommitFileSystem {
    func exists(_ path: URL) -> Bool
    func children(_ path: URL) throws -> [String]
    func read(_ path: URL, cap: Int) throws -> Data
    func byteCount(_ path: URL) throws -> Int
    /// The last modification time of a regular file, nil for anything else or a missing path.
    func modifiedAt(_ path: URL) -> Date?
    func createDirectory(_ path: URL) throws
    func writeAtomic(_ path: URL, bytes: Data) throws
    func excludeFromBackup(_ path: URL) throws
}

struct PrototypeLibraryReadFailure: Error {
    let kind: PrototypeSavedProblemKind
    let message: String
}

struct PrototypeLibraryDiskFileSystem: PrototypeLibraryFileSystem {
    private let disk = PrototypeBundleFileSystem()
    private let files = FileManager.default

    func exists(_ path: URL) -> Bool { files.fileExists(atPath: path.path) }
    func assertRealDirectory(_ path: URL) throws { try disk.assertRealDirectory(path) }
    func assertAbsent(_ path: URL) throws { try disk.assertAbsent(path) }
    func makeStagingDirectory(parent: URL, mode: UInt16) throws -> URL {
        try disk.makeStagingDirectory(parent: parent, mode: mode)
    }

    func mkdir(_ path: URL, mode: UInt16) throws { try disk.mkdir(path, mode: mode) }
    func writeExclusiveNoFollow(_ path: URL, bytes: Data) throws { try disk.writeExclusiveNoFollow(path, bytes: bytes) }
    func rename(from: URL, to destination: URL) throws { try disk.rename(from: from, to: destination) }
    func remove(_ path: URL) throws { try disk.remove(path) }

    func modifiedAt(_ path: URL) -> Date? {
        guard let attributes = try? files.attributesOfItem(atPath: path.path),
              attributes[.type] as? FileAttributeType == .typeRegular
        else { return nil }
        return attributes[.modificationDate] as? Date
    }

    func children(_ path: URL) throws -> [String] {
        try assertRealDirectory(path)
        return try files.contentsOfDirectory(atPath: path.path)
    }

    func createDirectory(_ path: URL) throws {
        try files.createDirectory(at: path, withIntermediateDirectories: true)
        try assertRealDirectory(path)
    }

    func excludeFromBackup(_ path: URL) throws {
        var url = path
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try url.setResourceValues(values)
    }

    func read(_ path: URL, cap: Int) throws -> Data {
        let attributes: [FileAttributeKey: Any]
        do { attributes = try files.attributesOfItem(atPath: path.path) }
        catch {
            let code = (error as NSError).code
            let missing = code == NSFileReadNoSuchFileError || code == NSFileNoSuchFileError
            throw PrototypeLibraryReadFailure(kind: missing ? .missing : .unreadable, message: "Cannot read file")
        }
        guard attributes[.type] as? FileAttributeType == .typeRegular else {
            throw PrototypeLibraryReadFailure(kind: .unsafePath, message: "Not a regular file")
        }
        guard let size = attributes[.size] as? NSNumber, size.int64Value > 0, size.int64Value <= Int64(cap) else {
            throw PrototypeLibraryReadFailure(kind: .oversized, message: "Empty file or byte cap exceeded")
        }
        let handle = try FileHandle(forReadingFrom: path)
        defer { try? handle.close() }
        let bytes = try handle.read(upToCount: cap + 1) ?? Data()
        guard !bytes.isEmpty, bytes.count <= cap else {
            throw PrototypeLibraryReadFailure(kind: .oversized, message: "Empty file or byte cap exceeded")
        }
        return bytes
    }

    func byteCount(_ path: URL) throws -> Int {
        let attributes = try files.attributesOfItem(atPath: path.path)
        if attributes[.type] as? FileAttributeType == .typeDirectory {
            return try children(path).reduce(0) { total, child in
                let bytes = try byteCount(path.appendingPathComponent(child))
                return min(PrototypeLibraryStore.maxBytes + 1, total + bytes)
            }
        }
        guard attributes[.type] as? FileAttributeType == .typeRegular,
              let bytes = attributes[.size] as? NSNumber
        else {
            throw PrototypeLibraryFailure(path: path.path, message: "Not a regular file or directory")
        }
        return Int(min(Int64(PrototypeLibraryStore.maxBytes + 1), bytes.int64Value))
    }

    func writeAtomic(_ path: URL, bytes: Data) throws {
        try assertRealDirectory(path.deletingLastPathComponent())
        try bytes.write(to: path, options: .atomic)
    }
}
