import Darwin
import Foundation

protocol PrototypeLibraryInput {
    var byteCount: Int? { get }
    func read(upToCount count: Int) throws -> Data
    func close() throws
}

extension PrototypeLibraryInput {
    func close() throws {} // Memory inputs own no descriptor.
}

protocol PrototypeLibraryReadFileSystem: Sendable {
    func openRegularFile(_ url: URL) throws -> any PrototypeLibraryInput
}

struct PrototypeLibraryReadDiskFileSystem: PrototypeLibraryReadFileSystem {
    func openRegularFile(_ url: URL) throws -> any PrototypeLibraryInput {
        let descriptor = Darwin.open(url.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
        guard descriptor >= 0 else { throw failure() }
        do {
            var info = stat()
            guard fstat(descriptor, &info) == 0 else { throw failure() }
            guard info.st_mode & S_IFMT == S_IFREG else {
                throw PrototypeLibraryImportFailure.invalid(path: "$", message: "Expected a regular file")
            }
            guard info.st_size >= 0, info.st_size <= PrototypeBundle.maxCompressedBytes else {
                throw PrototypeLibraryImportFailure.invalid(path: "$", message: "Import byte cap exceeded")
            }
            return DiskInput(handle: FileHandle(fileDescriptor: descriptor), byteCount: Int(info.st_size))
        } catch {
            Darwin.close(descriptor)
            throw error
        }
    }

    private func failure() -> POSIXError { POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }

    private struct DiskInput: PrototypeLibraryInput {
        let handle: FileHandle
        let byteCount: Int?
        func read(upToCount count: Int) throws -> Data { try handle.read(upToCount: count) ?? Data() }
        func close() throws { try handle.close() }
    }
}

/// Security-scoped access is owned by the UI. This reader never accepts a remote URL.
struct PrototypeLibraryFileReader: Sendable {
    var files: any PrototypeLibraryReadFileSystem = PrototypeLibraryReadDiskFileSystem()

    func read(_ url: URL) throws -> Data {
        guard url.isFileURL else {
            throw PrototypeLibraryImportFailure.invalid(path: "$", message: "Only local files can be imported")
        }
        let input = try files.openRegularFile(url)
        let result = Result { try read(input) }
        try input.close()
        return try result.get()
    }

    func read(_ input: any PrototypeLibraryInput) throws -> Data {
        if let size = input.byteCount, size > PrototypeBundle.maxCompressedBytes { throw oversized() }
        var bytes = Data()
        while bytes.count < 4 {
            let chunk = try input.read(upToCount: 4 - bytes.count)
            if chunk.isEmpty { break }
            bytes.append(chunk)
        }
        let cap = PrototypeLibraryImporter.isZIP(bytes) ? PrototypeBundle.maxCompressedBytes : PrototypeBundle
            .maxSpecBytes
        if let size = input.byteCount, size > cap { throw oversized() }
        while bytes.count <= cap {
            let chunk = try input.read(upToCount: min(65536, cap + 1 - bytes.count))
            if chunk.isEmpty { return bytes }
            bytes.append(chunk)
        }
        throw oversized()
    }

    private func oversized() -> PrototypeLibraryImportFailure {
        .invalid(path: "$", message: "Import byte cap exceeded")
    }
}
