import Foundation

// Persisted prototype storage (#12526, `prototype_storage_v1`): the device half of the spec's
// root-level `storage` block (#12522). This file holds the pure pieces and the file-backed store;
// `PrototypeStorageRestore` is the precedence function and `PrototypeStorageCoordinator` the
// debounced writer. UIKit-free, so `swift test` covers all of it against a temp directory.

/// The spec's `storage` block: `{version, keys: ["state:<key>" | "data:<pointer relative to /data>"]}`.
/// Decoding is lenient because the host validator owns the strict shape (`prototypeStorageError`):
/// a block that does not decode is treated as absent, so a malformed one never fails a show.
struct PrototypeStorageBlock: Decodable, Equatable {
    let version: Int
    let keys: [String]
}

/// One parsed storage key.
enum PrototypeStorageKey: Equatable {
    case state(String)
    case data(pointer: String)

    private static let statePrefix = "state:"
    private static let dataPrefix = "data:"

    /// `state:<key>` with a state-key name, or `data:<pointer>` addressing a member of `data`;
    /// anything else is nil (mirrors `parsePrototypeStorageKey` on the host).
    static func parse(_ storageKey: String) -> PrototypeStorageKey? {
        if storageKey.hasPrefix(statePrefix) {
            let key = String(storageKey.dropFirst(statePrefix.count))
            return isStateKey(key) ? .state(key) : nil
        }
        if storageKey.hasPrefix(dataPrefix) {
            let pointer = String(storageKey.dropFirst(dataPrefix.count))
            // `/data` + pointer is the path form every data action uses, so reuse its guard.
            return PrototypeDataWrite.pointer(ofPath: "/data" + pointer) == pointer ? .data(pointer: pointer) : nil
        }
        return nil
    }

    private static func isStateKey(_ key: String) -> Bool {
        PrototypeContractValidator.matches("stateKey", key)
    }
}

/// The values kept for one prototype id, with the `storage.version` they were stored under.
struct PrototypeStoredValues: Codable, Equatable {
    var version: Int
    /// By storage key (`state:darkMode`, `data:/cart`).
    var values: [String: JSONValue]
}

enum PrototypeStorageBytes {
    /// UTF-8 bytes of the storage key plus the compact JSON of the value, the unit of
    /// `MAX_PROTOTYPE_STORAGE_BYTES` (`prototypeStorageEntryBytes` on the host).
    static func entry(_ storageKey: String, _ value: JSONValue) -> Int {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        // Encoding a validated JSON value cannot fail; a value that does fail counts as too big.
        let json = (try? encoder.encode(value))?.count ?? Int.max / 2
        return storageKey.utf8.count + json
    }

    static func total(_ values: [String: JSONValue]) -> Int {
        values.reduce(0) { $0 + entry($1.key, $1.value) }
    }
}

enum PrototypeStorageError: Error, Equatable {
    /// The file exists but is not a stored-values record (bad JSON, wrong shape, oversized).
    case corrupt(String)
}

/// Where stored values live. The file-backed implementation is the real one; tests use a fake.
protocol PrototypeStorageStore {
    /// The values stored for `id`, nil when there are none. Throws `PrototypeStorageError.corrupt`
    /// for unreadable content, so the caller can log it and start clean.
    func load(id: String) throws -> PrototypeStoredValues?
    func save(_ stored: PrototypeStoredValues, id: String) throws
    /// Removing what is not there succeeds.
    func delete(id: String) throws
}

/// `<directory>/<sanitized id>.json`, written atomically. The default directory is
/// `Application Support/AutoMobilePrototypeAgent/storage` inside the app's own sandbox: the agent
/// runs inside someone else's app, so stored values never go to the app's own files or its
/// `UserDefaults` domain.
struct FilePrototypeStorageStore: PrototypeStorageStore {
    static let directoryName = "AutoMobilePrototypeAgent"
    static let subdirectoryName = "storage"
    /// Far above the 256 KiB the values may take plus JSON overhead; a bigger file was not written by us.
    static let maxFileBytes = 4 * PrototypeLimits.maxStorageBytes

    let directory: URL

    static func defaultDirectory(fileManager: FileManager = .default) -> URL? {
        fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent(directoryName, isDirectory: true)
            .appendingPathComponent(subdirectoryName, isDirectory: true)
    }

    /// Injective for short ids: every byte outside `[A-Za-z0-9_-]` becomes `%XX`, so `.`, `/` and `..`
    /// can never escape the directory or hide the file. An id whose encoding passes 120 characters
    /// keeps a prefix plus a 64-bit hash of the whole id.
    static func fileName(for id: String) -> String {
        let safe = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-".utf8)
        let encoded = id.utf8.map { byte in
            safe.contains(byte) ? String(UnicodeScalar(byte)) : String(format: "%%%02X", byte)
        }.joined()
        guard encoded.count > 120 else { return encoded.isEmpty ? "%empty" : encoded }
        var hash: UInt64 = 0xCBF2_9CE4_8422_2325
        for byte in id.utf8 {
            hash = (hash ^ UInt64(byte)) &* 0x100_0000_01B3
        }
        return String(encoded.prefix(100)) + "~" + String(format: "%016llx", hash)
    }

    func fileURL(for id: String) -> URL {
        directory.appendingPathComponent(Self.fileName(for: id) + ".json", isDirectory: false)
    }

    private struct Record: Codable {
        let id: String
        let version: Int
        let values: [String: JSONValue]
    }

    func load(id: String) throws -> PrototypeStoredValues? {
        let url = fileURL(for: id)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        let data = try Data(contentsOf: url)
        guard data.count <= Self.maxFileBytes else {
            throw PrototypeStorageError.corrupt("stored values file is \(data.count) bytes")
        }
        let record: Record
        do {
            record = try JSONDecoder().decode(Record.self, from: data)
        } catch {
            throw PrototypeStorageError.corrupt("\(error)")
        }
        // A truncated-name collision belongs to another id: it is not ours to restore.
        guard record.id == id else { return nil }
        return PrototypeStoredValues(version: record.version, values: record.values)
    }

    func save(_ stored: PrototypeStoredValues, id: String) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let data = try encoder.encode(Record(id: id, version: stored.version, values: stored.values))
        try data.write(to: fileURL(for: id), options: .atomic)
    }

    func delete(id: String) throws {
        let url = fileURL(for: id)
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        try FileManager.default.removeItem(at: url)
    }
}
