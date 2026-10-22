import Foundation

struct PrototypeLibraryFailure: Error, Equatable, LocalizedError {
    let path: String
    let message: String
    var errorDescription: String? { "\(path): \(message)" }
}

struct PrototypeLibraryEntry: Codable, Hashable, Identifiable {
    enum Source: String, Codable, Hashable { case mcp, file, share, paste }
    let libraryId: String
    let label: String
    let importedAt: Int
    var lastOpenedAt: Int
    let source: Source
    let specSha256: String
    let requires: [String]
    let pinned: Bool
    var id: String { libraryId }

    static func validateId(_ id: String) throws {
        guard let uuid = UUID(uuidString: id), uuid.uuidString.lowercased() == id else {
            throw PrototypeLibraryFailure(path: "libraryId", message: "Expected canonical lowercase UUID")
        }
    }

    static func decode(_ bytes: Data) throws -> Self {
        do {
            let bytes = try PrototypeStrictJSON.prepare(bytes)
            return try JSONDecoder().decode(Self.self, from: bytes)
        } catch let failure as PrototypeLibraryFailure { throw failure }
        catch { throw PrototypeLibraryFailure(path: "library.json", message: error.localizedDescription) }
    }

    func encoded() throws -> Data { try JSONEncoder().encode(self) }
}

extension PrototypeLibraryEntry {
    private struct Key: CodingKey {
        let stringValue: String
        var intValue: Int? { nil }
        init(stringValue: String) { self.stringValue = stringValue }
        init?(intValue _: Int) { return nil }
    }

    init(from decoder: any Decoder) throws {
        let fields = try decoder.container(keyedBy: Key.self)
        guard Set(fields.allKeys.map(\.stringValue)) == [
            "libraryId",
            "label",
            "importedAt",
            "lastOpenedAt",
            "source",
            "specSha256",
            "requires",
            "pinned",
        ] else {
            throw PrototypeLibraryFailure(path: "library.json", message: "Unknown or missing metadata keys")
        }
        libraryId = try fields.decode(String.self, forKey: Key(stringValue: "libraryId"))
        label = try fields.decode(String.self, forKey: Key(stringValue: "label"))
        importedAt = try fields.decode(Int.self, forKey: Key(stringValue: "importedAt"))
        lastOpenedAt = try fields.decode(Int.self, forKey: Key(stringValue: "lastOpenedAt"))
        source = try fields.decode(Source.self, forKey: Key(stringValue: "source"))
        specSha256 = try fields.decode(String.self, forKey: Key(stringValue: "specSha256"))
        requires = try fields.decode([String].self, forKey: Key(stringValue: "requires"))
        pinned = try fields.decode(Bool.self, forKey: Key(stringValue: "pinned"))
        try Self.validateId(libraryId)
        guard importedAt >= 0, lastOpenedAt >= 0, specSha256.utf8.count == 64,
              specSha256.utf8.allSatisfy({ (48 ... 57).contains($0) || (97 ... 102).contains($0) })
        else {
            throw PrototypeLibraryFailure(path: "library.json", message: "Invalid timestamp or spec hash")
        }
    }
}
