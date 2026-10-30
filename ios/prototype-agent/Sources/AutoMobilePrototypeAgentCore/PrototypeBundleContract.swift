import CryptoKit
import Foundation

/// Closed transport vocabulary, in the shared corpus order.
enum PrototypeBundleCode: String, CaseIterable, Sendable {
    case notAZip = "not_a_zip", entryNameForbidden = "entry_name_forbidden"
    case entryNotAllowed = "entry_not_allowed", duplicateEntry = "duplicate_entry", linkEntry = "link_entry"
    case encryptedEntry = "encrypted_entry", methodUnsupported = "method_unsupported", multiDisk = "multi_disk"
    case zip64Unsupported = "zip64_unsupported", extraFieldForbidden = "extra_field_forbidden"
    case headerMismatch = "header_mismatch", trailingBytes = "trailing_bytes", tooManyEntries = "too_many_entries"
    case entryTooLarge = "entry_too_large", archiveTooLarge = "archive_too_large",
         expandedTooLarge = "expanded_too_large"
    case ratioExceeded = "ratio_exceeded", sizeMismatch = "size_mismatch", crcMismatch = "crc_mismatch"
    case sha256Mismatch = "sha256_mismatch", manifestInvalid = "manifest_invalid", specShaMismatch = "spec_sha_mismatch"
    case specInvalidJSON = "spec_invalid_json", specInvalid = "spec_invalid", assetMissing = "asset_missing"
    case fontMissing = "font_missing", manifestEntryMissing = "manifest_entry_missing"
    case unreferencedAsset = "unreferenced_asset", assetTypeMismatch = "asset_type_mismatch",
         requiresInvalid = "requires_invalid"
    case customShadersUnsupported = "custom_shaders_unsupported"
}

struct PrototypeBundleFailure: Error, Equatable, LocalizedError {
    var errorDescription: String? { code == .customShadersUnsupported ? PrototypeCustomShaders.refusal : code.rawValue }
    let code: PrototypeBundleCode
    let path: String?
    init(_ code: PrototypeBundleCode, _ path: String? = nil) {
        self.code = code
        self.path = path
    }
}

func bundleRequire(_ condition: Bool, _ code: PrototypeBundleCode, _ path: String? = nil) throws {
    if !condition { throw PrototypeBundleFailure(code, path) }
}

/// String equality normalizes Unicode; bundle IDs explicitly do not.
struct PrototypeBundleID: Hashable, Sendable {
    let bytes: Data
    init(_ value: String) { bytes = Data(value.utf8) }
    var string: String { String(decoding: bytes, as: UTF8.self) }
}

struct PrototypeBundleAsset: Sendable {
    let mediaType: String
    let bytes: Data
    var sha256: String { PrototypeBundle.sha256(bytes) }
}

struct PrototypeBundle: Sendable {
    let spec: Data
    let assets: [PrototypeBundleID: PrototypeBundleAsset]
    let fonts: [PrototypeBundleID: PrototypeBundleAsset]
    let requires: [String]
    var specSha256: String { Self.sha256(spec) }

    /// Retry identity excludes labels/provenance and advisory capabilities, but includes all resource bytes.
    var importIdentity: String {
        var fields = [specSha256]
        for (group, resources) in [("images", assets), ("fonts", fonts)] {
            fields.append(contentsOf: [group, String(resources.count)])
            for (id, asset) in resources.sorted(by: { $0.key.bytes.lexicographicallyPrecedes($1.key.bytes) }) {
                fields.append(contentsOf: [id.string, asset.mediaType, asset.sha256])
            }
        }
        // UTF-8 byte lengths preserve exact ID spelling and make every field boundary unambiguous.
        let canonical = fields.reduce(into: Data()) { bytes, field in
            bytes.append(contentsOf: "\(field.utf8.count):".utf8)
            bytes.append(contentsOf: field.utf8)
        }
        return Self.sha256(canonical)
    }

    static let maxEntries = 36
    static let maxSpecBytes = 1_048_576
    static let maxManifestBytes = 65536
    static let assetLimits = PrototypeSavedLayoutLimits()
    static let maxExpandedBytes = assetLimits.maxTotalBytes + maxSpecBytes + maxManifestBytes
    static let maxCompressedBytes = maxExpandedBytes
    static let maxRatio = 100
    static let maxJSONDepth = 64

    static func sha256(_ bytes: Data) -> String {
        SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }

    static func cap(_ name: String) -> Int {
        if name == "spec.json" { return maxSpecBytes }
        if name == "bundle.json" { return maxManifestBytes }
        return name.hasPrefix("fonts/") ? assetLimits.maxFontBytes : assetLimits.maxImageBytes
    }
}
