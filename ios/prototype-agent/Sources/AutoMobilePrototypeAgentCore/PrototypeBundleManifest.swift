import Foundation

struct PrototypeBundleManifest {
    struct Asset {
        let id: PrototypeBundleID
        let file: String
        let sha256: String
        let mediaType: String
    }

    let specSha256: String
    let assets: [Asset]
    let fonts: [Asset]
    let requires: [String]

    init(_ data: Data) throws {
        let document = try PrototypeBundleJSON(data, code: .manifestInvalid, path: "bundle.json")
        guard let fields = document.value.objectFields,
              Set(fields.keys) == ["bundleFormatVersion", "specSha256", "assets", "fonts", "requires"],
              fields["bundleFormatVersion"] == .number(1),
              let hash = fields["specSha256"]?.stringValue, Self.validHash(hash),
              case let .array(images) = fields["assets"], case let .array(fonts) = fields["fonts"]
        else { throw PrototypeBundleFailure(.manifestInvalid, "bundle.json") }
        specSha256 = hash
        assets = try images.map(Self.record)
        self.fonts = try fonts.map(Self.record)
        guard case let .array(required) = fields["requires"] else {
            throw PrototypeBundleFailure(.requiresInvalid, "bundle.json")
        }
        var names: [String] = []
        for item in required {
            guard let name = item.stringValue,
                  name.range(of: #"^[a-z][a-z0-9_]*$"#, options: .regularExpression) != nil,
                  names.last.map({ $0 < name }) ?? true
            else { throw PrototypeBundleFailure(.requiresInvalid, "bundle.json") }
            names.append(name)
        }
        requires = names
        var ids = Set<PrototypeBundleID>()
        for (records, font) in [(assets, false), (self.fonts, true)] {
            for record in records {
                try bundleRequire(ids.insert(record.id).inserted, .manifestInvalid, record.id.string)
                try bundleRequire(record.mediaType.hasPrefix("font/") == font, .manifestInvalid, record.file)
                try bundleRequire(
                    record.file == Self.file(type: record.mediaType, hash: record.sha256),
                    .manifestInvalid,
                    record.file
                )
            }
        }
    }

    private static func record(_ value: JSONValue) throws -> Asset {
        if value.objectFields?["mediaType"]?.stringValue == PrototypeCustomShaders.mimeType {
            throw PrototypeBundleFailure(.customShadersUnsupported, "bundle.json")
        }
        guard let fields = value.objectFields, Set(fields.keys) == ["id", "file", "sha256", "mediaType"],
              let id = fields["id"]?.stringValue, validID(id), let file = fields["file"]?.stringValue,
              let hash = fields["sha256"]?.stringValue, validHash(hash),
              let type = fields["mediaType"]?.stringValue, PrototypeSavedLayout.extensions[type] != nil
        else { throw PrototypeBundleFailure(.manifestInvalid, "bundle.json") }
        return Asset(id: PrototypeBundleID(id), file: file, sha256: hash, mediaType: type)
    }

    static func validID(_ id: String) -> Bool {
        !id.isEmpty && id.utf16.count <= PrototypeBundle.assetLimits.maxIdLength
            && !PrototypeMediaItems.isMediaId(id)
    }

    private static func validHash(_ hash: String) -> Bool {
        hash.utf8.count == 64 && hash.utf8.allSatisfy { (48 ... 57).contains($0) || (97 ... 102).contains($0) }
    }

    static func file(type: String, hash: String) -> String {
        "\(type.hasPrefix("font/") ? "fonts" : "assets")/\(hash).\(PrototypeSavedLayout.extensions[type] ?? "")"
    }

    static func typeMatches(_ type: String, _ data: Data) -> Bool {
        let bytes = Array(data.prefix(12))
        switch type {
        case "image/png": return bytes.starts(with: [137, 80, 78, 71, 13, 10, 26, 10])
        case "image/jpeg": return bytes.starts(with: [255, 216, 255])
        case "image/webp":
            return bytes.count >= 12 && bytes.prefix(4).elementsEqual("RIFF".utf8) &&
                bytes[8 ..< 12].elementsEqual("WEBP".utf8)
        case "font/ttf": return bytes.starts(with: [0, 1, 0, 0]) || bytes.starts(with: "true".utf8)
        case "font/otf": return bytes.starts(with: "OTTO".utf8)
        default: return false
        }
    }
}
