import CryptoKit
import Foundation

enum PrototypeSavedLayout {
    static let formatVersion = 1
    static let manifestName = "manifest.json"
    static let specName = "spec.json"
    static let extensions = [
        "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp",
        "font/ttf": "ttf", "font/otf": "otf",
    ]
}

struct PrototypeSavedLayoutLimits {
    var maxImageBytes = 4_194_304
    var maxFontBytes = 2_097_152
    var maxAssetCount = 32
    var maxTotalBytes = 16_777_216
    var maxIdLength = 256
    var maxSpecBytes = PrototypeLimits.maxSpecBytes
    var maxManifestBytes = 262_144
}

struct PrototypeSavedAsset {
    let id: String
    let mediaType: String
    let isFont: Bool
    let sha256: String
    let data: Data
}

enum PrototypeSavedProblemKind: String {
    case missing, hashMismatch, oversized, unreadable, unsafePath
}

struct PrototypeSavedProblem: CustomStringConvertible {
    let assetId: String
    let kind: PrototypeSavedProblemKind
    let detail: String
    var description: String { "\(assetId): \(kind.rawValue): \(detail)" }
}

struct PrototypeSavedPrototype {
    let spec: PrototypeSpec
    let specData: Data
    let assets: [String: PrototypeSavedAsset]
    let problems: [PrototypeSavedProblem]
}

enum PrototypeSavedLoadResult {
    case loaded(PrototypeSavedPrototype)
    case notFound
    case unsupportedFormat(version: Int)
    case corrupt(String)
}

private struct SavedManifest: Decodable {
    let formatVersion: Int
    let specFile: String
    let assets: [SavedAssetRecord]
    let fonts: [SavedAssetRecord]
}

private struct SavedAssetRecord: Decodable {
    let id: String
    let file: String
    let sha256: String
    let mediaType: String
    var isFont: Bool { mediaType.hasPrefix("font/") }
}

private enum SavedReadError: Error {
    case invalid(String)
    case asset(PrototypeSavedProblemKind, String)
}

/// Unlike Android, this reads one prototype, with no slug/id/label/savedAt metadata.
/// Asset failures are recoverable problems for placeholders and inspect; manifest/spec failures are corrupt.
/// This reader never deletes or repairs files. Missing spec references need not have manifest entries.
struct PrototypeSavedLayoutReader {
    private let limits: PrototypeSavedLayoutLimits
    private let files: any PrototypeLibraryFileSystem

    init(
        limits: PrototypeSavedLayoutLimits = PrototypeSavedLayoutLimits(),
        files: any PrototypeLibraryFileSystem = PrototypeLibraryDiskFileSystem()
    ) {
        self.files = files
        self.limits = limits
    }

    func load(directory: URL) -> PrototypeSavedLoadResult {
        do {
            return try read(directory)
        } catch {
            return .corrupt(String(describing: error))
        }
    }

    private func read(_ directory: URL) throws -> PrototypeSavedLoadResult {
        guard files.exists(directory) else { return .notFound }
        try requireDirectory(directory)
        let children = try files.children(directory)
        if children.isEmpty { return .notFound }
        let manifestData = try boundedData(
            directory.appendingPathComponent(PrototypeSavedLayout.manifestName), cap: limits.maxManifestBytes
        )
        // JSONValue preserves bool vs number, rejects nonobjects, and avoids NSNumber boolean coercion.
        let document = try JSONDecoder().decode(JSONValue.self, from: PrototypeStrictJSON.prepare(manifestData))
        guard case let .object(fields) = document,
              case let .number(number) = fields["formatVersion"],
              let version = Int(exactly: number)
        else { throw SavedReadError.invalid("Missing or noninteger formatVersion") }
        if version != PrototypeSavedLayout.formatVersion { return .unsupportedFormat(version: version) }
        try strictManifest(fields)
        let manifest = try JSONDecoder().decode(SavedManifest.self, from: manifestData)
        try validate(manifest)
        let specData = try boundedData(directory.appendingPathComponent(manifest.specFile), cap: limits.maxSpecBytes)
        let spec = try JSONDecoder().decode(PrototypeSpec.self, from: specData)
        return try loadAssets(manifest, directory: directory, spec: spec, specData: specData)
    }

    private func strictManifest(_ fields: [String: JSONValue]) throws {
        guard Set(fields.keys) == Set(["formatVersion", "specFile", "assets", "fonts"])
        else { throw SavedReadError.invalid("Unknown or missing manifest keys") }
        for key in ["assets", "fonts"] {
            guard case let .array(entries) = fields[key]
            else { throw SavedReadError.invalid("Invalid manifest array") }
            for entry in entries {
                guard case let .object(record) = entry,
                      Set(record.keys) == Set(["id", "file", "sha256", "mediaType"])
                else { throw SavedReadError.invalid("Unknown or missing asset keys") }
            }
        }
    }

    private func validate(_ manifest: SavedManifest) throws {
        let records = manifest.assets + manifest.fonts
        guard manifest.specFile == PrototypeSavedLayout.specName, records.count <= limits.maxAssetCount
        else { throw SavedReadError.invalid("Invalid specFile or count") }
        var ids = Set<String>()
        for record in records {
            guard !record.id.isEmpty, record.id.utf16.count <= limits.maxIdLength,
                  ids.insert(record.id).inserted,
                  let ext = PrototypeSavedLayout.extensions[record.mediaType],
                  record.sha256.utf8.count == 64,
                  record.sha256.utf8.allSatisfy({ (48 ... 57).contains($0) || (97 ... 102).contains($0) })
            else { throw SavedReadError.invalid("Invalid asset metadata") }
            let folder = record.isFont ? "fonts" : "assets"
            guard record.file == "\(folder)/\(record.sha256).\(ext)"
            else { throw SavedReadError.invalid("Invalid asset path") }
        }
        guard manifest.assets.allSatisfy({ !$0.isFont }), manifest.fonts.allSatisfy(\.isFont)
        else { throw SavedReadError.invalid("Wrong asset folder") }
    }

    private func loadAssets(
        _ manifest: SavedManifest, directory: URL, spec: PrototypeSpec, specData: Data
    )
        throws -> PrototypeSavedLoadResult
    {
        var assets: [String: PrototypeSavedAsset] = [:]
        var problems: [PrototypeSavedProblem] = []
        let records = manifest.assets + manifest.fonts
        var total = 0
        for record in records {
            do {
                let data = try assetData(record, directory: directory)
                total += data.count
                assets[record.id] = PrototypeSavedAsset(
                    id: record.id, mediaType: record.mediaType, isFont: record.isFont,
                    sha256: record.sha256, data: data
                )
            } catch let SavedReadError.asset(kind, detail) {
                problems.append(PrototypeSavedProblem(assetId: record.id, kind: kind, detail: detail))
            } catch {
                problems.append(PrototypeSavedProblem(
                    assetId: record.id, kind: .unreadable, detail: "Cannot read asset bytes"
                ))
            }
            guard total <= limits.maxTotalBytes else { throw SavedReadError.invalid("Verified total exceeds cap") }
        }
        var references = Set<String>()
        spec.root.collectAssets(into: &references)
        spec.root.collectFontAssets(into: &references)
        let declared = Set(records.map(\.id))
        for id in references.subtracting(declared) {
            problems.append(PrototypeSavedProblem(assetId: id, kind: .missing, detail: "No manifest entry"))
        }
        problems.sort {
            ($0.assetId, $0.kind.rawValue) < ($1.assetId, $1.kind.rawValue)
        }
        return .loaded(PrototypeSavedPrototype(spec: spec, specData: specData, assets: assets, problems: problems))
    }

    private func assetData(_ record: SavedAssetRecord, directory: URL) throws -> Data {
        let url = directory.appendingPathComponent(record.file)
        let folder = url.deletingLastPathComponent()
        // Reject intermediate symlinks too, even when the leaf is an ordinary file.
        if files.exists(folder) { try requireDirectory(folder) }
        let cap = record.isFont ? limits.maxFontBytes : limits.maxImageBytes
        let data = try boundedData(url, cap: cap)
        let hash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        guard hash == record.sha256 else { throw SavedReadError.asset(.hashMismatch, "SHA-256 differs") }
        return data
    }

    private func requireDirectory(_ url: URL) throws {
        do { try files.assertRealDirectory(url) }
        catch { throw SavedReadError.asset(.unsafePath, "Not a regular directory") }
    }

    private func boundedData(_ url: URL, cap: Int) throws -> Data {
        do { return try files.read(url, cap: cap) }
        catch let failure as PrototypeLibraryReadFailure {
            throw SavedReadError.asset(failure.kind, failure.message)
        }
    }
}
