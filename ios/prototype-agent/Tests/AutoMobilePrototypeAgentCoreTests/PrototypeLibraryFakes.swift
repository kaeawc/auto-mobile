@testable import AutoMobilePrototypeAgentCore
import Foundation

final class PrototypeLibraryFakeFileSystem: PrototypeLibraryFileSystem {
    var directories = Set<String>()
    var data: [String: Data] = [:]
    var excluded = Set<String>()
    var sizes: [String: Int] = [:]
    var unreadable = Set<String>()
    var failWrite = false
    var calls = 0
    private var stage = 0

    func exists(_ path: URL) -> Bool { directories.contains(path.path) || data[path.path] != nil }
    func createDirectory(_ path: URL) throws { directories.insert(path.path) }
    func assertRealDirectory(_ path: URL) throws {
        calls += 1
        guard directories.contains(path.path) else { throw failure(path) }
    }

    func assertAbsent(_ path: URL) throws { if exists(path) { throw failure(path) } }
    func children(_ path: URL) throws -> [String] {
        try assertRealDirectory(path)
        return Set(directories.union(data.keys).filter {
            URL(fileURLWithPath: $0).deletingLastPathComponent().path == path.path
        }.map { URL(fileURLWithPath: $0).lastPathComponent }).sorted()
    }

    func read(_ path: URL, cap: Int) throws -> Data {
        calls += 1
        guard !unreadable.contains(path.path), let bytes = data[path.path] else { throw failure(path) }
        guard !bytes.isEmpty, bytes.count <= cap else { throw failure(path) }
        return bytes
    }

    func byteCount(_ path: URL) throws -> Int {
        if let size = sizes[path.path] { return size }
        return data.filter { $0.key.hasPrefix(path.path + "/") }.reduce(0) { $0 + $1.value.count }
    }

    func excludeFromBackup(_ path: URL) throws { excluded.insert(path.path) }
    func mkdir(_ path: URL, mode _: UInt16) throws { try createDirectory(path) }
    func makeStagingDirectory(parent: URL, mode _: UInt16) throws -> URL {
        stage += 1
        let path = parent.appendingPathComponent(".stage-\(stage)", isDirectory: true)
        try createDirectory(path)
        return path
    }

    func writeExclusiveNoFollow(_ path: URL, bytes: Data) throws {
        try assertAbsent(path)
        try writeAtomic(path, bytes: bytes)
    }

    func writeAtomic(_ path: URL, bytes: Data) throws {
        if failWrite { throw failure(path) }
        data[path.path] = bytes
    }

    func rename(from: URL, to destination: URL) throws {
        try assertAbsent(destination)
        let prefix = from.path
        for path in Array(directories) where path == prefix || path.hasPrefix(prefix + "/") {
            directories.remove(path)
            directories.insert(destination.path + path.dropFirst(prefix.count))
        }
        for (path, bytes) in data where path.hasPrefix(prefix + "/") {
            data.removeValue(forKey: path)
            data[destination.path + path.dropFirst(prefix.count)] = bytes
        }
    }

    func remove(_ path: URL) throws {
        directories = directories.filter { $0 != path.path && !$0.hasPrefix(path.path + "/") }
        data = data.filter { $0.key != path.path && !$0.key.hasPrefix(path.path + "/") }
    }

    private func failure(_ path: URL) -> PrototypeLibraryFailure {
        PrototypeLibraryFailure(path: path.path, message: "Fake I/O failure")
    }
}

final class PrototypeLibraryFakeClock: PrototypeClock {
    var nowMilliseconds = 1000
    func schedule(afterMilliseconds _: Int, _: @escaping () -> Void) -> PrototypeTimerHandle {
        PrototypeLibraryFakeTimer()
    }
}

private final class PrototypeLibraryFakeTimer: PrototypeTimerHandle {
    func cancel() {}
}
